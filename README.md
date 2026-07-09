# @offlocal/mcp

A local MCP server that gives an AI coding agent one `deploy` tool. You map each
project environment to a provider resource (Vercel, Railway, or Render) once, and
the agent deploys through a single tool that resolves the right project,
environment, and account, waits for the build, and returns the result.

Provider tokens are read from environment variables at call time and are not
written to disk. State (projects, environments, mappings) is stored as JSON files
under `.offlocal/`.

## Requirements

- Node >= 18.

## Install

The server runs from npm via `npx`; there is nothing to clone.

Claude Code — `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "offlocal": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "-p", "@offlocal/mcp", "offlocal-mcp"],
      "env": {
        "VERCEL_TOKEN": "your_vercel_token",
        "RAILWAY_TOKEN": "your_railway_token",
        "RENDER_API_KEY": "your_render_key"
      }
    }
  }
}
```

Cursor — `.cursor/mcp.json`, same shape without the `"type"` field.

Codex — `~/.codex/config.toml`:

```toml
[mcp_servers.offlocal]
command = "npx"
args = ["-y", "-p", "@offlocal/mcp", "offlocal-mcp"]
env = { VERCEL_TOKEN = "your_vercel_token", RENDER_API_KEY = "your_render_key" }
```

Include only the tokens for providers you use. Restart the agent or reconnect MCP
servers after editing the config.

## Provider tokens

| Variable | Provider | Notes |
|---|---|---|
| `VERCEL_TOKEN` | Vercel | Account or team token |
| `VERCEL_TEAM_ID` | Vercel | Optional; required for team-owned resources |
| `RAILWAY_TOKEN` | Railway | Account or workspace token |
| `RENDER_API_KEY` | Render | API key |
| `GITHUB_TOKEN` | GitHub | Fine-grained PAT (Metadata: read, Contents: read) |
| `SUPABASE_ACCESS_TOKEN` | Supabase | Personal access token |
| `STRIPE_TEST_SECRET_KEY` | Stripe | `sk_test_...` |
| `STRIPE_LIVE_SECRET_KEY` | Stripe | `sk_live_...` |

## Setup

There are no projects on first run. Create a project, add environments, and map
each environment to a provider resource. The agent does this by calling the setup
tools; you can describe it in plain language, for example:

> Create a project acme-crm with staging and production environments. Map the
> Vercel project acme-crm-preview to staging and acme-crm-prod to production.

The tools used are `create_project`, `add_environment`, and
`map_provider_resource`. State persists in `.offlocal/` in the agent's working
directory (override with the `OFFLOCAL_HOME` environment variable), so setup is
done once per machine. It can also be declared in a config file — see
[Config file](#config-file).

## The deploy tool

`deploy` takes a project and environment. It selects the provider mapped to that
environment, triggers the deployment, waits for the build to reach a terminal
state, and returns the result.

```jsonc
deploy({
  project: "acme-crm",
  environment: "staging",
  // provider     required only when the environment has more than one deploy target
  // wait         default true; set false to return immediately after triggering
  // timeout_seconds  default 180
  // commit_id    deploy a specific git commit (Vercel, Render)
})
```

Success returns the live URL:

```json
{
  "status": "deployed",
  "project": "acme-crm",
  "environment": "staging",
  "provider": "render",
  "deploymentId": "dep-abc123",
  "url": "https://acme-crm.onrender.com",
  "state": "live"
}
```

Failure returns the deployment state and a tail of the build logs:

```json
{
  "status": "failed",
  "provider": "render",
  "state": "build_failed",
  "logs": [
    { "timestamp": "2026-06-09T12:00:02.000Z", "level": "error", "message": "Error: DATABASE_URL is missing" }
  ]
}
```

A production deploy returns `status: "approval_required"` and does not execute;
see [Policy and audit](#policy-and-audit).

If `wait` is false, `deploy` returns `status: "deploying"` with the deployment id.
Use `get_deploy_status` to check it later.

Provider selection: if one deploy target is mapped to the environment it is used;
if more than one is mapped, pass `provider`; if none is mapped, `deploy` returns
an error.

## Providers

Deploy targets:

| Provider | Deploy | Logs | Env vars | API |
|---|---|---|---|---|
| Vercel | yes | yes | yes | REST |
| Railway | yes | yes | yes | GraphQL |
| Render | yes | yes | yes | REST |

Context and data providers: GitHub (repo metadata, README, files), Supabase
(project context, SQL with read/write classification), Stripe (products and
prices, test and live keys held separately).

## Other tools

- `get_app_logs` — fetch recent logs for an environment from the mapped
  provider. Recognizable secrets are redacted. Also `get_vercel_logs`,
  `get_railway_logs`, `get_render_logs`, `get_latest_deployment_logs`.
- `get_project_context` — for a project and optional environment, returns the
  mapped resources, the latest deployment status and URL (best-effort), project
  memory, recent audit entries, the allowed/blocked/approval-required action
  lists, and a text summary. Intended as the first call in a session.
- `read_project_memory` / `write_project_memory` — short notes per
  project/environment, included in `get_project_context`.

<details>
<summary>Full tool list</summary>

- Deploy: `deploy`, `get_deploy_status`
- Project/workspace: `list_projects`, `create_project`, `select_project`, `get_project_context`, `add_environment`, `list_environments`
- Connections/mappings: `add_provider_connection`, `list_provider_connections`, `map_provider_resource`, `list_provider_mappings`, `get_provider_mapping`
- Logs: `get_app_logs`, `get_latest_deployment_logs`, `get_vercel_logs`, `get_railway_logs`, `get_render_logs`
- Vercel: `get_vercel_project_context`, `get_vercel_deployments`, `get_vercel_deployment_status`, `get_vercel_deployment_logs`, `set_vercel_env_var`, `create_vercel_deployment`
- Railway: `get_railway_project_context`, `get_railway_deployments`, `create_railway_deployment`, `set_railway_env_var`
- Render: `get_render_service_context`, `get_render_deployments`, `create_render_deployment`, `set_render_env_var`
- Supabase: `list_supabase_projects`, `get_supabase_project_context`, `query_supabase`
- Stripe: `list_stripe_products`, `create_stripe_product`, `create_stripe_price`
- Memory/audit/policy: `read_project_memory`, `write_project_memory`, `list_audit_log`, `check_policy`, `list_policy_rules`, `set_policy_rule`

The `create_*_deployment` tools trigger a deploy without waiting. `deploy` wraps
them, waits, and returns the result.
</details>

## Policy and audit

Every provider action passes through one function (`runGuarded` in
`src/actions.ts`) that resolves project and environment, evaluates policy, and
writes an audit entry before any provider API is called. Policy is evaluated on
capability, environment, provider, and a live flag — not on tool names.

Defaults:

- Reads are allowed in every environment.
- Non-production writes and deploys are allowed.
- Production writes, deploys, and env-var changes return `approval_required`.
- Live Stripe writes return `approval_required`.
- Deleting resources and destructive SQL (`DROP`/`TRUNCATE`/`DELETE`/`ALTER`) are
  blocked in every environment.

An `approval_required` or `blocked` action does not call the provider and is
audited with `result: "not_executed"`. To allow a gated action, add a rule with
`set_policy_rule` (higher priority wins). There is no separate approve/deny
handshake yet.

The audit log is `.offlocal/audit.log`, one JSON line per attempt. Read it with
`list_audit_log`. Full reference: [docs/policy.md](docs/policy.md).

## Config file

Setup can be declared in `.offlocal/config.yaml` and seeded with the CLI instead
of creating it through the agent:

```bash
npx -p @offlocal/mcp offlocal init        # seeds from .offlocal/config.yaml if present
npx -p @offlocal/mcp offlocal context acme-crm --env staging
```

See [.offlocal/config.example.yaml](.offlocal/config.example.yaml) for the schema.
`require_approval` entries apply to production; `block` entries apply everywhere.

## CLI

The MCP tools are the primary interface. The CLI operates on the same `.offlocal/`
state and is used for seeding and inspection:

```bash
npx -p @offlocal/mcp offlocal init
npx -p @offlocal/mcp offlocal project create "Acme CRM"
npx -p @offlocal/mcp offlocal env add staging --kind staging
npx -p @offlocal/mcp offlocal map render staging --resource '{"serviceId":"srv-..."}'
npx -p @offlocal/mcp offlocal context acme-crm --env staging
```

Installed globally (`npm i -g @offlocal/mcp`), drop the `npx -p @offlocal/mcp`
prefix.

## Architecture

```
src/
  types.ts             domain types
  storage.ts           JSON storage under .offlocal/
  deploy.ts            deploy orchestrator: trigger, poll, report
  policy.ts            capability-based policy engine
  actions.ts           runGuarded(): policy + audit + execute
  context.ts           get_project_context
  resolve.ts           project/environment/mapping resolution
  provider-actions.ts  guarded provider operations
  providers/           REST/GraphQL adapters: github, vercel, railway, render, supabase, stripe
  tools/index.ts       MCP tool registration
  index.ts             stdio MCP server entry
  cli.ts               offlocal CLI
```

`deploy` triggers the deployment through `runGuarded`, so policy and audit apply,
then polls the provider until the deployment reaches a terminal state. Provider
adapters are stateless: token in, data out. Adding a provider is one adapter file
plus guarded actions and tool registrations.

Provider API details are in [docs/provider-research.md](docs/provider-research.md).

## Development

```bash
git clone https://github.com/adi4x4/offlocalai-mcp && cd offlocalai-mcp
npm install
npm run build        # compiles to dist/
npm test
npm run typecheck
```

To run a local build, point the agent at `"command": "node", "args":
["./dist/index.js"]`.

## Roadmap

- A real approve/deny handshake to replace approval-by-policy-rule.
- More deploy targets: Netlify, Cloudflare Pages/Workers, Fly.io.
- Deploy from a diff, per-branch preview URLs, rollbacks.
- Supabase migrations, Stripe subscriptions and invoices.

## License

[Apache License 2.0](LICENSE).
