# DashClaw Authoritative Gate and Evidence Ledger Design

## Summary

offlocal should integrate with DashClaw as the authoritative governance gate for risky provider actions. offlocal remains the local, context-rich execution layer for GitHub, Vercel, Supabase, Stripe, Railway, and future providers. DashClaw becomes the source of truth for guard decisions, approval requirements, and external evidence.

This design uses env-only DashClaw auth for the first version:

- `DASHCLAW_BASE_URL`
- `DASHCLAW_API_KEY`
- optional `DASHCLAW_TIMEOUT_MS`
- optional `OFFLOCAL_DASHCLAW_MODE`, default `authoritative`

Only `authoritative` mode is implemented in this spec. The mode variable exists so future observer or hybrid modes are explicit configuration choices, not accidental fallback behavior.

## Goals

- Use DashClaw as the final authority for risky offlocal provider actions.
- Keep offlocal's existing `runGuarded()` path as the single provider-action choke point.
- Preserve local offlocal audit invariants: every provider attempt is locally audited exactly once and provider calls never happen before the required guard decision.
- Record enough evidence in DashClaw to connect guard decisions, provider execution, local audit entries, and outcomes.
- Add product-facing tools that make the integration inspectable by agents and operators.

## Non-Goals

- Do not sync every offlocal provider mapping into DashClaw capabilities in this version.
- Do not replace all local offlocal policy logic. Local policy remains useful for previews and read actions.
- Do not store DashClaw API keys or provider secrets in offlocal state.
- Do not send raw provider secrets, decrypted env values, SQL result rows, log lines, or raw SQL text to DashClaw.
- Do not implement observer or hybrid mode in this spec.

## Architecture

Add a new `src/dashclaw/` integration layer:

- `client.ts`: small HTTP client for DashClaw. It reads `DASHCLAW_BASE_URL` and `DASHCLAW_API_KEY`, applies timeout handling, redacts secrets in errors, and normalizes transport failures.
- `guard.ts`: maps offlocal `ActionContext` into DashClaw guard context, calls `/api/guard`, and normalizes the decision into `allow`, `block`, or `require_approval`.
- `evidence.ts`: records lifecycle evidence through DashClaw action/outcome endpoints, primarily `POST /api/actions` and `POST /api/actions/[actionId]/outcome`.
- `types.ts`: normalized DashClaw request/response types internal to offlocal.

The existing `runGuarded()` function remains the single choke point for provider execution. For risky actions it calls DashClaw before provider execution. For read actions it can proceed using local policy if DashClaw is missing or unreachable.

Risky actions are:

- any `write`
- any `deploy`
- any `env_change`
- any `delete`
- any `destructive_sql`
- any action with `live: true`

Decision behavior:

- DashClaw `allow`: execute provider action.
- DashClaw `block`: do not execute; write local audit entry with `not_executed`.
- DashClaw `require_approval`: do not execute; return an approval-required offlocal response with DashClaw metadata.
- DashClaw unavailable for risky action: fail closed; do not execute; write a local audit entry that captures the failure.
- DashClaw unavailable for read action: proceed through local policy and local audit as today.

## DashClaw Guard Contract

offlocal sends DashClaw a structured guard context based on the provider action, not raw provider payloads.

Guard request fields:

- `action_type`: normalized from offlocal capability/tool. Examples: `provider_deploy`, `provider_env_change`, `database_write`, `stripe_live_write`, `provider_read`.
- `declared_goal`: offlocal action summary.
- `systems_touched`: provider/resource/environment labels such as `vercel:acme-crm-prod`, `project:acme-crm`, and `environment:production`.
- `reversible`: `false` for live Stripe, destructive SQL, deletes, production deploys, and production env changes; otherwise best-effort.
- `risk_score`: offlocal advisory score. DashClaw remains authoritative.
- `metadata`: structured context including:
  - offlocal project id, slug, and name
  - environment id, name, kind, and production flag
  - provider
  - capability
  - tool
  - resource label
  - local offlocal policy preview
  - live flag
  - local audit correlation id

Normalized DashClaw decisions:

- `allow`
- `block`
- `require_approval`

The normalizer accepts expected DashClaw aliases such as `require_approval` and `approval_required`. Unknown decisions fail closed for risky actions.

If DashClaw returns richer fields such as action id, decision id, reasons, signals, verification status, or approval metadata, offlocal preserves those in provider responses under `dashclaw`.

Example response:

```json
{
  "status": "approval_required",
  "policy_decision": "approval_required",
  "executed": false,
  "project": "acme-crm",
  "environment": "production",
  "provider": "vercel",
  "action": "create_vercel_deployment",
  "reason": "DashClaw requires approval for production deploy",
  "dashclaw": {
    "decision": "require_approval",
    "decision_id": "gd_...",
    "action_id": "act_...",
    "verification_status": "verified"
  }
}
```

The offlocal response vocabulary remains stable. DashClaw details are additive.

## Evidence Lifecycle

For risky actions, offlocal records both the pre-execution decision and the post-execution outcome.

1. offlocal builds the existing `ActionContext`, computes the local policy preview, resource label, and local correlation id.
2. offlocal calls DashClaw `/api/guard`.
3. If DashClaw blocks or requires approval, offlocal does not execute the provider call. It writes the local audit entry and returns the normalized response with DashClaw metadata.
4. If DashClaw allows, offlocal executes the provider call.
5. offlocal records the outcome to DashClaw via `POST /api/actions/[actionId]/outcome` when DashClaw supplied or created an action id:
   - success, error, or not executed
   - duration
   - provider, resource, capability, and tool
   - local audit correlation id
   - sanitized error message, if any
6. offlocal writes the local JSONL audit entry exactly once.

Outcome recording must not retroactively fail an action after the provider already succeeded. If DashClaw outcome recording fails after execution, offlocal returns the provider result and marks `dashclaw.outcome_recorded=false`.

## Error Handling and Safety Defaults

DashClaw env/config failures:

- Risky action plus missing DashClaw env: do not execute.
- Risky action plus DashClaw timeout: do not execute.
- Risky action plus DashClaw `401` or `403`: do not execute and return a clear setup/auth error.
- Risky action plus malformed DashClaw response: do not execute.
- Read action plus missing/unreachable DashClaw: proceed through current local policy and audit behavior.

Approval behavior:

- If DashClaw returns `require_approval`, offlocal does not create its own local approval request for that same action.
- offlocal returns DashClaw approval/action metadata and tells the agent to use DashClaw approval tooling.
- Existing offlocal approval APIs can remain for non-DashClaw workflows, but under authoritative mode they are not the approval authority for risky actions.

Secret handling:

- DashClaw context may include provider ids, project refs, repo names, deployment ids, and non-secret resource labels.
- DashClaw context must not include provider tokens, env var values, Stripe secret keys, SQL result rows, log lines, or decrypted secrets.
- For Supabase SQL, send classification, keyword, and a short fingerprint/hash by default, not the full SQL body.

Audit behavior:

- Local audit entries get optional DashClaw fields such as decision id, action id, outcome-recorded flag, and guard error.
- Backward compatibility with older audit log lines is required.
- Audit export includes DashClaw ids when present.

## Product Surface

Name the capability **Governed Infrastructure Actions**.

User-facing promise: agents can touch real infrastructure, but every risky action is guarded, approved, and evidenced.

New offlocal tools:

- `dashclaw_status`: verify DashClaw env config, base URL, auth, guard availability, and mode.
- `dashclaw_recent_decisions`: show recent DashClaw guard decisions scoped to offlocal project/environment.
- `export_dashclaw_evidence`: bundle local audit entries with DashClaw decision/action ids.
- `explain_action_risk`: dry-run local policy preview plus DashClaw risk context without executing.
- `governed_action_summary`: summarize provider action, local audit, DashClaw decision, and outcome.

## Follow-On Connections

After the DashClaw gate/evidence bridge, prioritize provider connections that improve diagnosis before risky writes:

- GitHub Actions/Checks: workflow runs, failed jobs/logs, rerun workflow, cancel workflow.
- Sentry: issues, releases, events, and release-health context.
- PostHog or analytics: feature flag reads/writes and event insight reads. Flag writes are risky.
- Slack/Discord approval bridge: notify humans when DashClaw requires approval, with offlocal provider context attached.
- Linear/GitHub Issues: require or attach change-ticket metadata for production actions.
- Cloudflare: DNS, Workers, and Pages deploys. High blast radius, good DashClaw fit.

Recommended first follow-on extension: GitHub Actions plus Sentry.

## Tests

Core tests:

- Risky action calls DashClaw before provider execution.
- DashClaw `allow` executes provider exactly once and audits exactly once.
- DashClaw `block` does not execute provider and audits `not_executed`.
- DashClaw `require_approval` does not execute provider and includes DashClaw metadata.
- Missing DashClaw env fails closed for risky actions.
- DashClaw timeout, `401`, malformed response, or unknown decision fails closed for risky actions.
- Read actions proceed when DashClaw is unavailable.
- Outcome recording failure after provider success does not hide provider success.

Contract tests:

- offlocal `ActionContext` maps into a stable DashClaw guard payload.
- Secret-bearing fields are absent from guard/evidence payloads.
- Supabase SQL sends classification/hash, not raw SQL.
- Normalized DashClaw decisions accept expected aliases and reject unknown values loudly.

Integration-style mocked-fetch tests:

- Guard, provider, and outcome calls happen in the expected order.
- `dashclaw_status` probes health without requiring provider mappings.
- `dashclaw_recent_decisions` and `export_dashclaw_evidence` filter by project/environment.
- Audit export includes DashClaw ids when present.

## Implementation Notes

- Keep `runGuarded()` as the only provider execution choke point.
- Extract helpers from `runGuarded()` if necessary, but do not let provider actions call DashClaw directly.
- Keep local policy terminology distinct from DashClaw policy terminology. Local policy is a preview/fallback for reads; DashClaw is the authority for risky actions.
- Keep DashClaw integration isolated from provider adapters. Provider adapters should remain token-in/data-out.
- Use env-only auth for DashClaw in this version.

## Open Questions Resolved

- DashClaw mode: authoritative for risky actions.
- Failure policy: fail closed for risky actions, allow reads to proceed locally.
- Auth model: env-only for the first version.
