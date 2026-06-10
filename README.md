# @offlocal/mcp

**Production context layer for AI coding agents.**

> MCPs give AI agents *tools*. offlocal.ai gives AI agents *production context*.

When an AI coding agent (Claude Code, Codex, Cursor) connects to a provider MCP,
it typically gets one account wired in globally. But real developers don't live
in one account. They have:

- one GitHub org with many repos,
- one or more Vercel teams/projects,
- multiple Supabase projects,
- Stripe test/live accounts,
- staging vs production,
- client projects,
- and production resources that must not be touched without approval.

A tool that can "deploy to Vercel" is dangerous if the agent doesn't know
*which* Vercel project, in *which* environment, for *which* account — and
whether it's even allowed to.

`@offlocal/mcp` is one local MCP server an agent connects to so it can ask:

- Which project am I working on?
- Which environment is active?
- Which GitHub repo / Vercel project / Supabase project / Stripe mode belongs to it?
- What am I allowed to do? What's blocked? What requires human approval?
- What happened last time?

It resolves **project → environment → provider mapping → policy/safety check →
provider API → audit log / project memory** before any real action runs.

---

## The problem, concretely

```
AI coding agent
  → @offlocal/mcp
    → workspace
      → project            (your-project)
        → environment      (staging | production)
          → provider mappings   (github repo, vercel project, supabase ref, stripe mode, r2 bucket, clerk app)
            → policy / safety check   (allow | block | approval_required)
              → provider API action
                → audit log + project memory
```

Every provider action is forced through one choke point that resolves the right
account/environment, checks policy, and writes an audit entry. There is no path
to a provider call that skips this.

---

## Status: V0

- Local-first and **open source** (Apache 2.0). Runs entirely on your machine.
- Providers: **GitHub, Vercel, Supabase, Stripe, Neon, Upstash, Namecheap, Sentry, PostHog, Clerk, Resend, Twilio**
  (direct REST APIs) and **Railway** (GraphQL API).
- Storage: plain JSON files under `.offlocal/` (zero native deps).
- Auth: **environment variables only** — tokens are read at call time and never
  written to disk.

See [`docs/provider-research.md`](docs/provider-research.md) for the API/auth
research behind each adapter.

---

## Getting started

Requires Node ≥ 18. There is **nothing to clone and no config file to fill in** —
the server runs straight from npm, and you set everything else up by talking to
your agent.

### Step 1 — Add offlocal to your AI agent

Point your agent at `@offlocal/mcp` over `npx` and pass the provider tokens you
actually use as env vars. The server is published to npm, so `npx` fetches and
runs it on demand.

**Claude Code** — create `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "offlocal": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "-p", "@offlocal/mcp", "offlocal-mcp"],
      "env": {
        "GITHUB_TOKEN": "ghp_your_token",
        "VERCEL_TOKEN": "your_vercel_token",
        "RAILWAY_TOKEN": "your_railway_token"
      }
    }
  }
}
```

**Cursor** — `.cursor/mcp.json` (same shape, drop the `"type"` field).
**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.offlocal]
command = "npx"
args = ["-y", "-p", "@offlocal/mcp", "offlocal-mcp"]
env = { GITHUB_TOKEN = "ghp_your_token", VERCEL_TOKEN = "your_vercel_token" }
```

> Only include tokens for the providers you'll use — every other provider simply
> stays unavailable. Tokens are read at call time and never written to disk.
> Restart your agent (or reconnect MCP servers) after editing the config.

### Step 2 — Provider tokens

| Variable | Provider | Notes |
|---|---|---|
| `GITHUB_TOKEN` | GitHub | Fine-grained PAT (Metadata: read, Contents: read, Actions: read; Actions: write for rerun/cancel) |
| `VERCEL_TOKEN` | Vercel | Account/team token |
| `VERCEL_TEAM_ID` | Vercel | Optional; required for team-owned resources |
| `SUPABASE_ACCESS_TOKEN` | Supabase | Personal access token |
| `STRIPE_TEST_SECRET_KEY` | Stripe | `sk_test_...` |
| `STRIPE_LIVE_SECRET_KEY` | Stripe | `sk_live_...` — only used when policy allows a live write |
| `RAILWAY_TOKEN` | Railway | Account/workspace token |
| `NEON_API_KEY` | Neon | API key from console.neon.tech → Account settings → API keys |
| `UPSTASH_EMAIL` | Upstash | Account email for Developer API Basic auth |
| `UPSTASH_API_KEY` | Upstash | Developer API key from Account → Management API |
| `QSTASH_TOKEN` | Upstash QStash | Token for background jobs, cron schedules, and webhook delivery |
| `QSTASH_CURRENT_SIGNING_KEY` | Upstash QStash | Current signing key for verifying QStash requests |
| `QSTASH_NEXT_SIGNING_KEY` | Upstash QStash | Next signing key for zero-downtime key rotation |
| `CLOUDFLARE_API_TOKEN` | Cloudflare R2 | API token for R2 bucket management |
| `R2_ACCESS_KEY_ID` | Cloudflare R2 | S3-compatible access key id for app env wiring |
| `R2_SECRET_ACCESS_KEY` | Cloudflare R2 | S3-compatible secret access key for app env wiring |
| `SENTRY_AUTH_TOKEN` | Sentry | Org auth token for project/client-key setup |
| `POSTHOG_PERSONAL_API_KEY` | PostHog | Personal API key for project/client env and feature-flag APIs |
| `CLERK_SECRET_KEY` | Clerk | Backend API secret key; publishable key is mapped per environment |
| `RESEND_API_KEY` | Resend | API key for transactional email/domain setup |
| `TWILIO_AUTH_TOKEN` | Twilio | Auth token; map `accountSid` per environment |
| `NAMECHEAP_API_USER` | Namecheap | Account username (also sent as `UserName`) |
| `NAMECHEAP_API_KEY` | Namecheap | API key from Profile → Tools → API Access |
| `NAMECHEAP_CLIENT_IP` | Namecheap | Your current public IP — must be whitelisted in API Access |
| `NAMECHEAP_SANDBOX` | Namecheap | `true` targets api.sandbox.namecheap.com (recommended until ready) |
| `OFFLOCAL_HTTP_TIMEOUT_MS` | Runtime | Optional provider API timeout in milliseconds; defaults to `30000` |
| `OFFLOCAL_HTTP_RETRIES` | Runtime | Optional retry count for idempotent provider reads; defaults to `2` |
| `OFFLOCAL_HTTP_RETRY_BASE_MS` | Runtime | Optional linear retry delay base in milliseconds; defaults to `25` |
| `OFFLOCAL_LOCK_STALE_MS` | Runtime | Optional stale local file-lock threshold in milliseconds; defaults to `30000` |
| `OFFLOCAL_MEMORY_MAX_ENTRIES` | Runtime | Optional cap for retained local memory entries |
| `OFFLOCAL_AUDIT_MAX_ENTRIES` | Runtime | Optional cap for retained audit log entries |
| `OFFLOCAL_LOG_STARTUP` | Runtime | Set to `true` to emit structured CLI startup logs to stderr |
| `DASHCLAW_BASE_URL` | DashClaw | Optional authoritative governance gate base URL |
| `DASHCLAW_API_KEY` | DashClaw | Workspace API key sent as `x-api-key` |
| `DASHCLAW_TIMEOUT_MS` | DashClaw | Optional DashClaw timeout in milliseconds; defaults to `30000` |
| `OFFLOCAL_DASHCLAW_MODE` | DashClaw | `authoritative` in this version |

### Step 3 — Let the agent set up your project (no YAML)

The **first time** you connect there are no projects yet — that's expected. You
don't create them by hand or edit any file; you just ask your agent, and it calls
the setup tools for you. For example:

> "Use offlocal to create a project called **acme-crm** with a **staging** and a
> **production** environment. Map my Vercel project **acme-crm-preview** to
> staging and **acme-crm-prod** to production, and map Railway project
> **`<railway-project-id>`** to production. Map Sentry org
> **acme** and project **acme-crm** for observability, map Resend domain
> **example.com** for transactional email, map PostHog organization
> **`<posthog-org-id>`** and project **`<posthog-project-id>`** for analytics,
> map Upstash Redis database **`<upstash-database-id>`** for caching,
> use QStash for background jobs and cron schedules,
> map Cloudflare R2 bucket **`<r2-bucket>`** for object storage,
> map Clerk publishable key **`pk_test_...`** for authentication,
> and map my Twilio account
> **`AC...`** with sender **`+15551230000`** for SMS/voice."

Then start asking it to do real work:

> "What's safe to touch in acme-crm staging?"
> "Fetch the latest staging logs."
> "Deploy acme-crm to Railway staging."

Behind the scenes the agent uses `create_project`, `add_environment`,
`map_provider_resource`, `get_project_context`, and the provider tools — all
gated by policy and written to the audit log. Your setup persists in a local
`.offlocal/` directory (in the agent's working directory; override with the
`OFFLOCAL_HOME` env var), so you only do Step 3 once per machine.
Advanced setups can pass `connectionId` to `map_provider_resource` when a
resource must use a specific provider connection; the id is validated before the
mapping is stored and shown again by `list_provider_mappings` /
`get_provider_mapping`.

That's the whole setup. **You never have to write a config file.**

### Optional — declare everything in a config file instead

If you'd rather keep your setup as a version-controlled, repeatable file (handy
for seeding several projects at once or sharing across a team), you *can* describe
it in `.offlocal/config.yaml` and seed it with the bundled CLI — but this is
entirely optional and most people can skip it:

```bash
npx -p @offlocal/mcp offlocal init        # seeds from .offlocal/config.yaml if present
npx -p @offlocal/mcp offlocal context acme-crm --env staging
```

See [`.offlocal/config.example.yaml`](.offlocal/config.example.yaml) for the full
schema. `require_approval` entries apply to **production** (staging/dev stay
permissive); `block` entries apply **everywhere**.

### Want zero setup?

The self-hosted core in this repo is free and Apache-2.0 — you bring your own
provider tokens and run it locally. A **managed** offering (hosted credential
vault, one-click provider connect, real approve/deny workflows, an audit
dashboard, and team seats) removes the manual steps above for teams that want it.
See [offlocal.ai](https://offlocal.ai).

---

## MCP tools

**Project / workspace:** `list_projects`, `create_project`, `select_project`,
`get_project_context`, `export_context`, `doctor`, `add_environment`,
`list_environments`

**Provider mappings:** `map_provider_resource`, `list_provider_mappings`,
`get_provider_mapping`, `list_connections`, `create_connection`

**Policy / approval:** `check_policy`, `list_policy_rules`, `set_policy_rule`,
`simulate_action`, `list_pending_approvals`, `approve_action`, `reject_action`

**Memory / audit:** `read_project_memory`, `write_project_memory`,
`list_audit_log`, `export_audit_log`

**DashClaw:** `dashclaw_status`, `dashclaw_recent_decisions`,
`export_dashclaw_evidence`, `explain_action_risk`,
`governed_action_summary`

**GitHub:** `get_github_repo_context`, `get_github_repo_readme`,
`list_github_repo_files`, `list_github_pull_requests`, `list_github_branches`,
`get_github_status_checks`, `list_github_workflow_runs`,
`list_github_workflow_jobs`, `rerun_github_workflow_run`*,
`cancel_github_workflow_run`*

**App logs:** `get_app_logs`, `get_vercel_logs`, `get_latest_deployment_logs`

**Env wiring:** `set_app_env_vars`* (bulk set validated env vars on mapped
Vercel/Railway apps without putting values in DashClaw or audit summaries)

**Vercel:** `get_vercel_project_context`, `get_vercel_deployments`,
`get_vercel_deployment_status`, `get_vercel_deployment_logs`,
`create_vercel_project`* (create a new Vercel project),
`add_vercel_domain`* (attach a domain; returns the DNS records to set),
`set_vercel_env_var`*, `create_vercel_deployment`*

**Railway:** `get_railway_project_context`, `get_railway_deployments`,
`discover_railway_resources`, `get_railway_logs`, `create_railway_deployment`*,
`set_railway_env_var`*

**Supabase:** `list_supabase_projects`, `get_supabase_project_context`,
`get_supabase_logs`, `query_supabase`*, `apply_supabase_migration`*

**Stripe:** `list_stripe_products`, `list_stripe_customers`,
`list_stripe_subscriptions`, `list_stripe_invoices`, `create_stripe_product`*,
`create_stripe_price`*,
`create_stripe_webhook`* (create a webhook endpoint; returns the `whsec_` secret once),
`list_stripe_webhooks` (list webhook endpoints)

**Sentry:** `list_sentry_projects`, `create_sentry_project`*,
`list_sentry_client_keys`, `create_sentry_client_key`* (returns public
`SENTRY_DSN` for env-var wiring; secret DSNs are stripped),
`list_sentry_releases`, `create_sentry_release`*, `list_sentry_deploys`,
`create_sentry_deploy`*

**PostHog:** `list_posthog_projects`, `create_posthog_project`* (returns
`NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST`, and
`POSTHOG_PROJECT_ID` for env-var wiring; private project secrets are stripped),
`get_posthog_project_env`, `list_posthog_feature_flags`,
`create_posthog_feature_flag`*

**Resend:** `list_resend_domains`, `create_resend_domain`* (returns DNS records),
`verify_resend_domain`*, `send_resend_email`* (live external communication)

**Twilio:** `list_twilio_phone_numbers`,
`update_twilio_phone_number_webhooks`* (wire inbound SMS/voice URLs),
`send_twilio_sms`* (live external communication), `create_twilio_call`*
(live external communication)

**Neon:** `list_neon_projects` (list Neon Postgres projects),
`create_neon_project`* (provision a database; returns the connection URI),
`get_neon_connection_uri` (fetch a DATABASE_URL; redacted from audit)

**Upstash:** `list_upstash_redis_databases`, `create_upstash_redis_database`*
(provision serverless Redis and return `UPSTASH_REDIS_REST_URL`,
`UPSTASH_REDIS_REST_TOKEN`, and `UPSTASH_REDIS_READ_ONLY_REST_TOKEN` for
env-var wiring), `get_upstash_redis_env`, `get_upstash_qstash_env` (returns
`QSTASH_URL`, `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, and
`QSTASH_NEXT_SIGNING_KEY` for app env wiring),
`list_upstash_qstash_schedules`, `create_upstash_qstash_schedule`*
(background job / cron delivery setup; request bodies and forwarded headers are
redacted in QStash)

**Cloudflare R2:** `list_cloudflare_r2_buckets`,
`create_cloudflare_r2_bucket`* (create object storage and return
`R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ENDPOINT`, and `R2_REGION` wiring),
`get_cloudflare_r2_env`, `list_cloudflare_r2_objects`

**Clerk:** `get_clerk_app_env` (returns `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
and optional sign-in/sign-up env wiring), `list_clerk_users`,
`list_clerk_domains`, `list_clerk_redirect_urls`,
`create_clerk_redirect_url`*

**Namecheap:** `check_domain_availability` (availability + premium pricing),
`list_namecheap_domains` (domains in the account),
`purchase_domain`** (register a domain — real money, always needs approval),
`get_dns_records` (current host records),
`set_dns_records`* (REPLACES ALL host records for the domain)

\* gated by policy (production / live / destructive operations require approval
or are blocked — see below).

\*\* `purchase` capability: approval is **always** required and cannot be
policy-allowed.

📖 **New here?** [docs/how-to.md](docs/how-to.md) is the 15-minute hands-on
walkthrough; [docs/architecture.md](docs/architecture.md) explains MCP and
the guard flow in plain language; [docs/launch-playbook.md](docs/launch-playbook.md)
walks a full domain → Vercel → Neon → Stripe launch end-to-end.

> `get_project_context` is the one to call **first**. For a project (and
> optionally a focused `environment`) it returns: the GitHub repo, the Vercel
> project + **live latest deployment status / URL / failure** (best-effort), the
> Supabase project, the Stripe mode, the **allowed / blocked / approval-required**
> action lists, project memory, recent audit history, **suggested safe next
> actions**, and a human-readable `summary` the agent can reason from directly.

---

## Governed Infrastructure Actions

offlocal can use DashClaw as the authoritative guard for risky provider actions.
In this mode, offlocal remains the provider execution layer and DashClaw becomes
the decision, approval, and evidence authority.

Risky actions are writes, deploys, env-var changes, deletes, destructive SQL, and
live-mode actions. These actions call DashClaw before execution. If DashClaw
allows the action, offlocal executes it and records the outcome. If DashClaw
blocks or requires approval, offlocal does not call the provider. If DashClaw is
unavailable, risky actions fail closed. Read actions continue through local
policy and audit.

Required env vars:

| Variable | Notes |
|---|---|
| `DASHCLAW_BASE_URL` | DashClaw base URL, e.g. `https://dashclaw.example.com` |
| `DASHCLAW_API_KEY` | Workspace API key sent as `x-api-key` |
| `DASHCLAW_TIMEOUT_MS` | Optional DashClaw timeout; defaults to `30000` |
| `OFFLOCAL_DASHCLAW_MODE` | `authoritative` in this version |

DashClaw tools:

- `dashclaw_status`
- `dashclaw_recent_decisions`
- `export_dashclaw_evidence`
- `explain_action_risk`
- `governed_action_summary`

---

## Fetch app logs

Ask the agent something like *"Use offlocal to fetch the latest staging logs."*
It resolves the project/environment, finds the mapped Vercel project, fetches the
latest deployment's logs, and the read is written to the audit log.

- `get_app_logs` — generic. Pass `project` + `environment` (and optionally
  `provider`, `deployment_id`, `since`, `limit`). With no `provider` it reads
  every mapped provider that supports logs (Vercel + Railway in V0, Vercel
  prioritized).
- `get_vercel_logs` / `get_railway_logs` — provider-specific. Resolve the latest
  deployment when `deployment_id` is omitted; return the deployment
  id/url/status plus logs.
- `get_latest_deployment_logs` — convenience; latest deployment for the mapped
  provider (`provider` defaults to Vercel, also accepts `railway`).

Log reads are a `read` capability, so they are **allowed by default in every
environment, including production**. Secrets are redacted from log lines where
recognizable, and every read is audited. If the provider's API can't return log
lines, the tool returns the deployment status plus a clear `limitation` instead
of failing silently — it never fabricates logs.

```json
{
  "status": "ok",
  "project": "acme-crm",
  "environment": "staging",
  "provider": "vercel",
  "policy_decision": "allow",
  "executed": true,
  "data": {
    "resource": {
      "project": "acme-crm-preview",
      "deployment_id": "dpl_…",
      "deployment_url": "https://acme-crm-preview.vercel.app",
      "deployment_status": "ERROR"
    },
    "time_range": { "since": null },
    "logs": [
      { "timestamp": "2026-06-09T12:00:02.000Z", "level": "error", "message": "Error: DATABASE_URL is missing" }
    ],
    "audit_written": true
  }
}
```

> Vercel's events API exposes build logs and recent runtime events. Older
> runtime logs require a configured log drain and are not retrievable through
> this API — the tool reports that as a `limitation`.

---

## Policy & safety behavior

The policy engine reasons about **capability × environment × provider × live-flag**,
not individual tool names — so new tools inherit safe defaults automatically.

Defaults:

| Situation | Default |
|---|---|
| Any read | **allow** |
| Dev/staging write (non-destructive) | **allow** |
| Production write / deploy / env-var change | **approval_required** |
| Live Stripe write | **approval_required** |
| Destructive SQL (`DROP`/`TRUNCATE`/`DELETE`/`ALTER`…) | **block** (everywhere) |
| Deleting resources | **block** (everywhere) |
| Every provider action | **logged** to the audit trail |

You override defaults with explicit rules (`set_policy_rule`) — higher priority
wins. This is how you opt *into* something normally gated (e.g. "allow live
Stripe writes for this reviewed project").

When an action needs approval, the tool returns a structured response instead of
executing:

```json
{
  "status": "approval_required",
  "policy_decision": "approval_required",
  "executed": false,
  "reason": "Production deploys require approval by default.",
  "project": "your-project",
  "environment": "production",
  "provider": "vercel",
  "action": "create_vercel_deployment",
  "approval_id": "approval_...",
  "suggested_next_step": "Review this request, then call approve_action with approval_id ..."
}
```

Approval is a two-step handshake. A gated action creates a pending approval
record and never calls the provider. `approve_action` marks that request
approved for one matching rerun; it still does **not** execute the provider
call. Rerun the original action after approval. The approval is consumed after
that rerun, so repeated production actions need fresh review. `reject_action`
closes a pending request without allowing execution. Approval and rejection
decisions are written to the audit log as `core` entries.

Every provider response carries explicit `policy_decision` (`allow` / `block` /
`approval_required`) and `executed` (boolean) fields. Blocked actions return
`"status": "blocked"`. Both blocked and approval-required responses set
`executed: false` and are written to the audit log with `result: "not_executed"`
— the provider API is never called. Allowed provider actions reserve the audit
log before execution; if the audit log cannot be locked/written, the action
returns `executed: false` and the provider API is not called.

### Audit log

Every attempt appends a JSON line to `.offlocal/audit.log` with: timestamp,
project, environment, provider, tool, action summary, policy decision
(allow/block/approval_required), result (success/error/not_executed), error
message, and the provider resource used.

### Project memory

Agents read/write short notes per project/environment (`read_project_memory` /
`write_project_memory`). Memory is also bundled into `get_project_context`, so a
future agent session sees what happened before — e.g. *"Last Vercel deploy failed
because DATABASE_URL was missing."*

---

## CLI (optional)

The MCP tools are the primary interface and most people never need the CLI — your
agent does setup and inspection for you (Step 3 above). The `offlocal` CLI exists
for scripting or seeding from a config file:

```bash
npx -p @offlocal/mcp offlocal init                # seed from .offlocal/config.yaml
npx -p @offlocal/mcp offlocal project create "Acme CRM"
npx -p @offlocal/mcp offlocal env add staging --kind staging
npx -p @offlocal/mcp offlocal map railway staging --resource '{"projectId":"<id>"}'
npx -p @offlocal/mcp offlocal map vercel staging --connection conn_team_a --resource '{"projectId":"<id>"}'
npx -p @offlocal/mcp offlocal context acme-crm --env staging
```

Installed globally (`npm i -g @offlocal/mcp`), drop the `npx -p @offlocal/mcp`
prefix and just run `offlocal ...`.

---

## Develop from source

Contributing or running an unreleased build:

```bash
git clone https://github.com/adi4x4/offlocalai-mcp && cd offlocalai-mcp
npm install
npm run verify       # typecheck + tests + build + npm audit
```

Then point your agent at the local build with `"command": "node", "args":
["./dist/index.js"]` instead of the `npx` form above.

---

## Architecture

```
src/
  types.ts           domain types (Workspace/Project/Environment/Connection/Mapping/PolicyRule/Audit/Memory)
  storage.ts         local-first JSON storage (.offlocal/)
  policy.ts          capability-based policy engine (the safety core)
  actions.ts         runGuarded() — the single choke point: policy + audit + execute
  context.ts         get_project_context bundle
  resolve.ts         project/environment/mapping resolution
  sql.ts             SQL classification (defense-in-depth)
  service.ts         business logic (used by both MCP tools and CLI)
  provider-actions.ts  guarded provider operations
  providers/         isolated REST adapters: github, vercel, railway, supabase, stripe, neon, upstash, upstash-qstash, cloudflare-r2, namecheap, sentry, posthog, clerk, resend, twilio
  tools/index.ts     MCP tool registration
  index.ts           stdio MCP server entry
  cli.ts             offlocal CLI
```

Provider adapters are isolated and stateless (token in, data out). Adding a
provider = one adapter file + a few guarded actions + tool registrations.

---

## Roadmap

- **More provider surface** (full Vercel file-upload deploys and deeper
  provider-specific diagnostics).
- **More providers** (the adapter interface is the extension point).
- **Optional SQLite backend** if state grows beyond the local JSON store.

## Known V0 limitations / TODOs

- Vercel `create_deployment` supports redeploy-by-id / git-backed deploys; full
  file-upload deploys are out of scope (documented in the research note).
- Local SQL classification is defense-in-depth, **not** a security boundary —
  Supabase's backend `read_only` flag is the real enforcement for reads. For
  production, also use a **read-only database role / restricted credentials** so a
  misclassified statement can't write even if it slips past the classifier.
- Local JSON state uses per-file locks and atomic renames; audit appends are
  locked as well. It is not a multi-user database.
- Stripe live writes are gated but, once allowed, are not transactional/rollback-able.

## License

[Apache License 2.0](LICENSE).
