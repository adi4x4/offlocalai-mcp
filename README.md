# offlocalai-mcp

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

`offlocalai-mcp` is one local MCP server an agent connects to so it can ask:

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
  → offlocalai-mcp
    → workspace
      → project            (your-project)
        → environment      (staging | production)
          → provider mappings   (github repo, vercel project, supabase ref, stripe mode)
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
- Providers: **GitHub, Vercel, Supabase, Stripe** (direct REST APIs).
- Storage: plain JSON files under `.offlocal/` (zero native deps).
- Auth: **environment variables only** — tokens are read at call time and never
  written to disk.

See [`docs/provider-research.md`](docs/provider-research.md) for the API/auth
research behind each adapter.

---

## Install & build

```bash
git clone <repo> && cd offlocalai-mcp
npm install
npm run build      # compiles to dist/
npm test           # 24 tests
npm run typecheck
```

Requires Node ≥ 18 (developed on Node 22).

## Configure a project

Describe your real projects in `.offlocal/config.yaml`, then seed state:

```bash
cp .offlocal/config.example.yaml .offlocal/config.yaml
# edit it — replace the placeholders with your real repos/projects/refs
node dist/cli.js init
node dist/cli.js context <your-project>
```

`.offlocal/config.yaml` — projects → environments → which provider account each
environment uses, plus policy. Replace every placeholder with your real values:

```yaml
projects:
  your-project:                              # id-safe slug
    name: Your Project
    environments:
      staging:
        github:   { repo: your-org/your-repo }
        vercel:   { project: your-staging-vercel-project }
        supabase: { project_ref: your_staging_project_ref }
        stripe:   { mode: test }
      production:
        github:   { repo: your-org/your-repo }
        vercel:   { project: your-production-vercel-project }
        supabase: { project_ref: your_production_project_ref }
        stripe:   { mode: live }
    memory:
      - environment: production
        note: "Production DB writes are blocked by default."
policy:
  require_approval: [ vercel.deploy, vercel.env.write, supabase.write, stripe.write ]
  block:            [ supabase.destructive_sql, provider.delete ]
```

You can also build state imperatively without a config file:
`offlocal project create`, `offlocal env add`, `offlocal map <provider> <env> --resource '<json>'`.

`require_approval` entries apply to **production** (staging/dev keep permissive
defaults so they stay usable); `block` entries apply **everywhere**.

## Provider environment variables

Set only the providers you use. Tokens are read at call time and never persisted.

| Variable | Provider | Notes |
|---|---|---|
| `GITHUB_TOKEN` | GitHub | Fine-grained PAT (Metadata: read, Contents: read) |
| `VERCEL_TOKEN` | Vercel | Account/team token |
| `VERCEL_TEAM_ID` | Vercel | Optional; required for team-owned resources |
| `SUPABASE_ACCESS_TOKEN` | Supabase | Personal access token |
| `STRIPE_TEST_SECRET_KEY` | Stripe | `sk_test_...` |
| `STRIPE_LIVE_SECRET_KEY` | Stripe | `sk_live_...` — only used when policy allows a live write |

## Connect the MCP server

**Claude Code** — project-scoped `.mcp.json`:

```json
{
  "mcpServers": {
    "offlocalai": {
      "type": "stdio",
      "command": "node",
      "args": ["./dist/index.js"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}",
        "VERCEL_TOKEN": "${VERCEL_TOKEN}",
        "SUPABASE_ACCESS_TOKEN": "${SUPABASE_ACCESS_TOKEN}",
        "STRIPE_TEST_SECRET_KEY": "${STRIPE_TEST_SECRET_KEY}",
        "STRIPE_LIVE_SECRET_KEY": "${STRIPE_LIVE_SECRET_KEY}"
      }
    }
  }
}
```

Or: `claude mcp add --transport stdio offlocalai --env GITHUB_TOKEN=... -- node ./dist/index.js`

**Cursor** — `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "offlocalai": {
      "command": "node",
      "args": ["./dist/index.js"],
      "env": { "GITHUB_TOKEN": "xxx" }
    }
  }
}
```

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.offlocalai]
command = "node"
args = ["./dist/index.js"]
env = { GITHUB_TOKEN = "xxx" }
```

The server reads `.offlocal/` from the current working directory (override with
`OFFLOCAL_HOME`).

---

## MCP tools

**Project / workspace:** `list_projects`, `create_project`, `select_project`,
`get_project_context`, `add_environment`, `list_environments`

**Provider mappings:** `map_provider_resource`, `list_provider_mappings`,
`get_provider_mapping`

**Policy:** `check_policy`, `list_policy_rules`, `set_policy_rule`

**Memory / audit:** `read_project_memory`, `write_project_memory`,
`list_audit_log`

**GitHub:** `get_github_repo_context`, `get_github_repo_readme`,
`list_github_repo_files`

**App logs:** `get_app_logs`, `get_vercel_logs`, `get_latest_deployment_logs`

**Vercel:** `get_vercel_project_context`, `get_vercel_deployments`,
`get_vercel_deployment_status`, `get_vercel_deployment_logs`,
`set_vercel_env_var`*, `create_vercel_deployment`*

**Supabase:** `list_supabase_projects`, `get_supabase_project_context`,
`query_supabase`*

**Stripe:** `list_stripe_products`, `create_stripe_product`*,
`create_stripe_price`*

\* gated by policy (production / live / destructive operations require approval
or are blocked — see below).

> `get_project_context` is the one to call **first**. For a project (and
> optionally a focused `environment`) it returns: the GitHub repo, the Vercel
> project + **live latest deployment status / URL / failure** (best-effort), the
> Supabase project, the Stripe mode, the **allowed / blocked / approval-required**
> action lists, project memory, recent audit history, **suggested safe next
> actions**, and a human-readable `summary` the agent can reason from directly.

---

## Fetch app logs

Ask the agent something like *"Use offlocalai to fetch the latest staging logs."*
It resolves the project/environment, finds the mapped Vercel project, fetches the
latest deployment's logs, and the read is written to the audit log.

- `get_app_logs` — generic. Pass `project` + `environment` (and optionally
  `provider`, `deployment_id`, `since`, `limit`). With no `provider` it reads
  every mapped provider that supports logs (Vercel prioritized in V0).
- `get_vercel_logs` — Vercel-specific. Resolves the latest deployment when
  `deployment_id` is omitted; returns the deployment id/url/status plus logs.
- `get_latest_deployment_logs` — convenience; latest deployment for the mapped
  provider (default Vercel).

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
  "suggested_next_step": "Approve manually by adding an allow PolicyRule (set_policy_rule) ..."
}
```

Every provider response carries explicit `policy_decision` (`allow` / `block` /
`approval_required`) and `executed` (boolean) fields. Blocked actions return
`"status": "blocked"`. Both blocked and approval-required responses set
`executed: false` and are written to the audit log with `result: "not_executed"`
— the provider API is never called.

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

## CLI

The MCP tools are the primary interface; the `offlocal` CLI is for setup/inspection:

```bash
offlocal init                                   # seed from .offlocal/config.yaml
offlocal project create "Your Project"
offlocal env add staging --kind staging
offlocal map github staging --resource '{"owner":"your-org","repo":"your-repo"}'
offlocal context your-project
```

(Use `node dist/cli.js ...` before publishing, or `npm run cli -- ...` in dev.)

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
  providers/         isolated REST adapters: github, vercel, supabase, stripe
  tools/index.ts     MCP tool registration
  index.ts           stdio MCP server entry
  cli.ts             offlocal CLI
```

Provider adapters are isolated and stateless (token in, data out). Adding a
provider = one adapter file + a few guarded actions + tool registrations.

---

## Roadmap

- **Approval flow** — replace the `approval_required` response with a real
  approve/deny handshake (e.g. an `approve_action` tool + pending-action store).
- **More provider surface** (Vercel git-backed deploys & file uploads, Supabase
  migrations, Stripe subscriptions/invoices).
- **More providers** (the adapter interface is the extension point).
- **Optional SQLite backend** + cross-process locking if state grows.

## Known V0 limitations / TODOs

- No real approval handshake yet — approval is granted by adding a policy rule.
- Vercel `create_deployment` supports redeploy-by-id / git-backed deploys; full
  file-upload deploys are out of scope (documented in the research note).
- Local SQL classification is defense-in-depth, **not** a security boundary —
  Supabase's backend `read_only` flag is the real enforcement for reads. For
  production, also use a **read-only database role / restricted credentials** so a
  misclassified statement can't write even if it slips past the classifier.
- No cross-process file locking on `.offlocal/state.json`.
- Stripe live writes are gated but, once allowed, are not transactional/rollback-able.

## License

[Apache License 2.0](LICENSE).
