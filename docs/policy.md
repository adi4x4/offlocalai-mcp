# Policy and audit

Every provider action passes through `runGuarded` (`src/actions.ts`), which
resolves project and environment, evaluates policy, and writes an audit entry
before any provider API is called.

Policy is evaluated on capability, environment, provider, and a live flag, not on
tool names. New tools inherit the defaults for their capability.

## Defaults

| Situation | Decision |
|---|---|
| Any read, including logs, in any environment | allow |
| Dev or staging write or deploy (non-destructive) | allow |
| Production write, deploy, or env-var change | approval_required |
| Live Stripe write | approval_required |
| Destructive SQL (`DROP`/`TRUNCATE`/`DELETE`/`ALTER`) | block (all environments) |
| Deleting resources | block (all environments) |

Every action is written to the audit log regardless of the decision.

## Approval-required and blocked responses

A gated action does not call the provider. The tool returns a structured response
with `executed: false`:

```json
{
  "status": "approval_required",
  "policy_decision": "approval_required",
  "executed": false,
  "reason": "Production deploys require approval by default.",
  "project": "acme-crm",
  "environment": "production",
  "provider": "vercel",
  "action": "create_vercel_deployment",
  "suggested_next_step": "Approve manually by adding an allow PolicyRule (set_policy_rule) ..."
}
```

Blocked actions return `status: "blocked"`. Both are audited with
`result: "not_executed"`.

Every provider response includes `policy_decision` (`allow` / `block` /
`approval_required`) and `executed`.

## Allowing a gated action

Add a rule with `set_policy_rule`. Higher `priority` wins. A rule matches when
every field set in its `match` matches the action; unset fields are wildcards.

There is no separate approve/deny handshake. Approval is granted by adding a rule.

## Audit log

`.offlocal/audit.log`, one JSON line per attempt. Each line records timestamp,
project, environment, provider, tool, action summary, policy decision, result
(`success` / `error` / `not_executed`), error message, and the provider resource
used. Read it with `list_audit_log`.

## Config-file policy

When seeding from `.offlocal/config.yaml`, policy is declared as capability
tokens:

```yaml
policy:
  require_approval:      # applied to production; staging and dev stay permissive
    - vercel.deploy
    - railway.deploy
    - render.deploy
    - supabase.write
    - stripe.write
  block:                 # applied in all environments
    - supabase.destructive_sql
    - provider.delete
```

Tokens are `<provider>.<capability>`, or `provider.<capability>` for any
provider. Capabilities: `read`, `write`, `deploy`, `env.write`,
`destructive_sql`, `delete`.

## Limitations

- No approve/deny handshake; approval is a policy rule. `set_policy_rule` is
  itself an MCP tool, so an autonomous agent can add its own allow rule. For a
  hard boundary, keep credentials out of the agent (for example, CI-only tokens).
- A rule with no `capability` set matches every capability, including `delete`
  and `destructive_sql`. A broad "allow everything in staging" rule therefore
  also lifts the hard blocks. Set `capability` on allow rules.
- Local SQL classification is defense-in-depth, not a security boundary. Use a
  read-only database role for production reads.
- Allowed Stripe live writes are not transactional or reversible.
- No cross-process file locking on `.offlocal/state.json`.
