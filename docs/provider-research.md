# Provider Research — offlocal.ai V0

> Researched against current official docs on **2026-06-08**. This note backs the
> V0 adapter design. For each provider: auth, env vars, main APIs, dangerous vs
> safe actions, scoping, limitations, and TODOs.

**Design stance for V0:** call provider REST APIs directly (not provider MCPs) so
we control auth, policy, routing, and audit. Auth is via environment variables
only; tokens are read at call time and never persisted.

| Provider | Auth | Env var(s) |
|---|---|---|
| GitHub | Fine-grained PAT | `GITHUB_TOKEN` |
| Vercel | Account/team token | `VERCEL_TOKEN`, `VERCEL_TEAM_ID?` |
| Railway | Account/workspace token | `RAILWAY_TOKEN` |
| Render | API key | `RENDER_API_KEY` |
| Supabase | Personal Access Token | `SUPABASE_ACCESS_TOKEN` |
| Stripe | Secret keys (test+live) | `STRIPE_TEST_SECRET_KEY`, `STRIPE_LIVE_SECRET_KEY` |

---

## GitHub

_Researched against docs.github.com, current as of 2026-06-08._

### REST API basics
- **Base URL:** `https://api.github.com`
- **API version header:** `X-GitHub-Api-Version: 2026-03-10` (latest). If omitted, requests default to `2022-11-28` — always send it explicitly. Unsupported versions return `410 Gone`.
- **Auth header:** `Authorization: Bearer <TOKEN>`. Also send `Accept: application/vnd.github+json`.

### Auth model
- **Fine-grained PAT via `GITHUB_TOKEN`.** No callback flow, least-privilege per repo. Grant **Metadata: read** (mandatory) + **Contents: read** for the read path; add **Contents: write** only when writes are enabled (off by default). Classic PAT works but is coarser.

### Key endpoints
| Purpose | Method + Path | Permission |
|---|---|---|
| Get repo metadata (incl. `default_branch`) | `GET /repos/{owner}/{repo}` | Metadata: read |
| Get README | `GET /repos/{owner}/{repo}/readme` | Contents: read |
| Get file/dir contents | `GET /repos/{owner}/{repo}/contents/{path}` | Contents: read |
| List branches | `GET /repos/{owner}/{repo}/branches` | Contents: read |
| List deployments | `GET /repos/{owner}/{repo}/deployments` | Deployments: read |
| Create/update a file (write) | `PUT /repos/{owner}/{repo}/contents/{path}` | Contents: write |
| Delete a file (write) | `DELETE /repos/{owner}/{repo}/contents/{path}` | Contents: write |

Default branch is the `default_branch` field on the repo object (no separate endpoint).

### Rate limits (authenticated)
- PAT / authenticated user: 5,000 req/hour. Secondary limits: ≤100 concurrent, content-creating writes ≤80/min & ≤500/hr. Honor `x-ratelimit-remaining` / `x-ratelimit-reset`.

### Safe vs dangerous
- **Safe (read-only GETs, V0 surface):** get repo, get README, get contents, list branches, list deployments.
- **Dangerous (gate / never expose):** `DELETE .../contents/{path}` (file delete), `DELETE /repos/{owner}/{repo}` (repo delete — **not exposed in V0**), force ref updates, branch deletion, workflow-file writes (need extra scope).

### Scoping
- `{owner}` works identically for user and org repos. Fine-grained PATs are scoped to one resource owner + selected repos (separate token per org; org owner approval may be required). Classic PATs span everything the user can access (coarser).

### Limitations / TODOs
- Fine-grained PATs can't cover multiple orgs in one token — surface clear errors.
- Pin `X-GitHub-Api-Version`; versions expire on a 24-month window.

---

## Vercel

_Researched against vercel.com/docs/rest-api (reference last_updated 2026-06-08). Machine-readable source: `https://openapi.vercel.sh/`._

### Base URL, auth, scoping
- **Base URL:** `https://api.vercel.com`
- **Auth:** `Authorization: Bearer <token>` via `VERCEL_TOKEN`. Server-side only.
- **Team scoping:** append `?teamId=<id>` (or `?slug=<team-slug>`) to **every** team-resource request, sourced from `VERCEL_TEAM_ID`. Omitting it on a team install returns `403`.

### Key endpoints (note the mixed API versions)
| Action | Method + path | Notes |
|---|---|---|
| Get a project | `GET /v9/projects/{idOrName}` | id or name |
| List projects | `GET /v9/projects` | paginated |
| List deployments | `GET /v7/deployments` | **v7**, not v6. Filters: `projectId`, `target`, `state`, `limit`… |
| Get deployment / status | `GET /v13/deployments/{idOrUrl}` | id or hostname |
| Deployment events / build logs | `GET /v3/deployments/{idOrUrl}/events` | `follow`, `limit=-1` for all, `builds=1` |
| List env vars | `GET /v10/projects/{idOrName}/env` | `decrypt` exposes secrets — treat as sensitive |
| Create env var(s) | `POST /v10/projects/{idOrName}/env` | `{key,value,type,target}`; `?upsert=true` |
| Edit env var | `PATCH /v9/projects/{idOrName}/env/{id}` | partial |
| Delete env var | `DELETE /v9/projects/{idOrName}/env/{id}` | destructive |
| Create a deployment | `POST /v13/deployments` | git metadata or `files`; `target: production` is the dangerous case |

**Deployment status** (`readyState`/`state`): `QUEUED`, `INITIALIZING`, `BUILDING`, `READY`, `ERROR`, `CANCELED`, `BLOCKED`, `DELETED`; when `READY`, `readySubstate ∈ {STAGED, ROLLING, PROMOTED}`. `errorCode`/`errorMessage` populate on failure.

### Auth model
- **`VERCEL_TOKEN`** (account/team token). Simplest for local single-user use. Thread `teamId` (from `VERCEL_TEAM_ID`) onto every team-resource request.

### Safe vs dangerous
- **Safe / read-only:** get project, list/get deployments, deployment events/logs, env var metadata.
- **Dangerous (gate):** `POST /v13/deployments` with `target: production`; create/patch env vars targeting `production`; delete env var; `upsert=true` / `forceNew=1`.

### Rate limits
- `X-RateLimit-*` headers + `429`. Builds: **100/hour** (hard). Production deploys: 500/min. Respect `Retry-After` / `X-RateLimit-Reset`.

### Limitations / TODOs
- **Version drift:** endpoints span v3/v7/v9/v10/v13 — pin per-endpoint versions; do not assume a global version.
- File-based (non-git) deploys require uploading all files — heavy; V0 prefers git-backed deploys or redeploy-by-`deploymentId`.
- Reading env vars can return decrypted secrets — never log values; gate `decrypt=true`.
- Most `403`s are a missing `teamId` or insufficient scope — explain explicitly.

---

## Supabase

_Sources: Supabase Management API reference; official `supabase-community/supabase-mcp`. 2026-06-08._

### Management API basics
- **Base URL:** `https://api.supabase.com`, all endpoints under `/v1`.
- **Auth:** `Authorization: Bearer <PAT>` via `SUPABASE_ACCESS_TOKEN`. The PAT carries the **full privileges of the issuing account** — there is no narrower scope in V0.

### Key endpoints
| Action | Method + Path | Notes |
|---|---|---|
| List projects | `GET /v1/projects` | all projects the PAT can see |
| Get project details | `GET /v1/projects/{ref}` | `{ref}` = project ref |
| **Run SQL** | `POST /v1/projects/{ref}/database/query` | body `{ query, read_only?, parameters? }` |

`POST .../database/query` is the official, supported way to run SQL — **it does not need to be stubbed.** It runs **arbitrary SQL with elevated/service-role privileges** and returns JSON rows. `read_only: true` makes the backend run the query as a read-only Postgres user (real enforcement happens server-side, not via local SQL parsing).

### How the official supabase-mcp handles safety
- `execute_sql` → POSTs to the query endpoint; `read_only` option forces `read_only: true` and disables mutating tools (`apply_migration`, project create/pause/restore, edge-function deploy, branching).
- **Project scoping:** with `--project-ref` set, account-level tools (`list_projects`) are not loaded — server is pinned to one project.
- Guidance: don't connect to production; use a dev project; keep read-only on; keep manual tool-call approval on.

### Auth model
- **PAT (`SUPABASE_ACCESS_TOKEN`).** Simple, no callback flow. The PAT carries the full privileges of the issuing account — there is no narrower scope, which is exactly why project scoping + policy gating matter.

### Scoping danger
- **All-projects mode** (ref omitted) lets the PAT read/act on **every project in the account** — one mistake or prompt-injection can hit unrelated production projects. **Default our server to required project scoping** (mapping must name a `projectRef`).

### Safe vs dangerous
- **Safe / read-only:** list projects, get project, `SELECT` via query with `read_only: true`.
- **Dangerous:** any non-read-only query (`DROP`, `DELETE`, `TRUNCATE`, `ALTER`, `UPDATE`, `INSERT`), `apply_migration`, project create/pause/restore, edge deploys. Effectively irreversible against prod. Even a read-only `SELECT` can leak all rows (PII).

### Limitations / TODOs
- SQL execution is straightforward — use the query endpoint with `{ query, read_only }`.
- Local SQL classification (safe/write/destructive regex) is **defense-in-depth UX**, not a security boundary — the backend `read_only` flag is the real enforcement. V0 implements both: local classification to block destructive SQL early + `read_only` flag on reads. For production, also use a read-only DB role / restricted credentials.

---

## Stripe

_Researched against docs.stripe.com and github.com/stripe/agent-toolkit (stripe/ai). 2026-06-08._

### Base URL, auth & mode separation
- **Base URL:** `https://api.stripe.com`, REST under `/v1`.
- **Auth:** `Authorization: Bearer <secret_key>` (Stripe's curl uses Basic `-u key:` — equivalent; we use Bearer).
- **Mode is determined entirely by the key prefix.** Test and live are fully separate object spaces; there is **no per-request mode flag** — the key *is* the mode. `sk_test_...` → test, `sk_live_...` → live.
- **Env vars:** `STRIPE_TEST_SECRET_KEY`, `STRIPE_LIVE_SECRET_KEY`. Default to test.

### Restricted keys (`rk_...`)
Per-resource permissions (Read/Write/None) set in the Dashboard. Limit blast radius if leaked; grant only Products + Prices write for V0. Recommended over full secret keys for new integrations.

### Key endpoints (bodies are **form-encoded**, not JSON)
| Action | Method | Path | Notes |
|---|---|---|---|
| Create product | `POST` | `/v1/products` | required: `name` |
| List products | `GET` | `/v1/products` | `limit`, `starting_after` |
| Create price | `POST` | `/v1/prices` | `currency` + amount + `product`; nested `recurring[interval]=month` |
| List prices | `GET` | `/v1/prices` | filter by `product`, `active` |

Nested fields use bracket syntax: `recurring[interval]=month`, `product_data[name]=Gold`.

### Official Stripe agent toolkit / MCP
- Exists: `github.com/stripe/agent-toolkit` (now under `github.com/stripe/ai`). Local: `npx -y @stripe/mcp@latest --api-key=<key>`. **It relies solely on the key prefix for mode and exposes no "are you sure, this is live" guard** — so our test/live gate is something we must add ourselves.

### Auth model
- **Secret keys from env** (`STRIPE_TEST_SECRET_KEY` / `STRIPE_LIVE_SECRET_KEY`). Consider scoping with a **restricted key** (`rk_...`) granting only Products + Prices write.

### Safe vs dangerous
- **Safe:** any read; any write in **test mode**.
- **Dangerous:** **any write with a `_live_` key** — creating/updating live products/prices, refunds, subscription changes. Real, customer-visible, often irreversible.

### Safety implications
- Default to test mode. Gate all live writes behind explicit policy/approval. Surface mode prominently ("LIVE") in responses. Stripe writes are generally not rollback-able; products/prices are **archived** (`active=false`), not deleted. Use idempotency keys on POSTs.

### Limitations / TODOs
- Implement form-encoding incl. bracketed nested params (Stripe is not JSON-in).
- Add idempotency-key support; pagination for lists.
- Out of scope for V0: webhooks and broader resources (subscriptions/invoices/payment links).

---

## Railway

_Researched against docs.railway.com (public-api, graphql-overview, manage-deployments). 2026-06-09._

### Base URL, auth & API shape
- **Endpoint:** `https://backboard.railway.com/graphql/v2` — a single **GraphQL** endpoint (no REST). Every call is `POST` with `{query, variables}`; the rest of our adapters are REST, so Railway gets its own thin `gql()` helper.
- **Auth (token types):**
  | Token | Scope | Header |
  |---|---|---|
  | Account | all resources/workspaces — personal/local | `Authorization: Bearer <token>` |
  | Workspace | one workspace — team CI/CD | `Authorization: Bearer <token>` |
  | Project | one environment in a project | `Project-Access-Token: <token>` |
  | OAuth | user-granted | `Authorization: Bearer <token>` |
- **V0 uses an account/workspace token via `Authorization: Bearer` (`RAILWAY_TOKEN`).** Project-token header support is out of scope for V0.
- **Resource model:** project → environment → service → deployment. A mapping carries `projectId` (required) plus optional `environmentId`/`serviceId` to scope deployment + log reads.

### Key queries
| Action | Query | Notes |
|---|---|---|
| Verify token | `me { id name email }` | account/workspace tokens |
| Project + topology | `project(id) { name environments{edges{node{id name}}} services{edges{node{id name}}} }` | id is an opaque UUID |
| List deployments | `deployments(input: DeploymentListInput!, first: Int) { edges{node{id status createdAt url staticUrl}} }` | input: `projectId` (req), `environmentId?`, `serviceId?`; most-recent first |
| Deployment logs | `deploymentLogs(deploymentId: String!, limit: Int, startDate: DateTime, endDate: DateTime, filter: String) { timestamp message severity }` | runtime logs |
| Build logs | `buildLogs(deploymentId: String!, limit: Int) { timestamp message severity }` | build-time logs |

### Key mutations (gated by policy)
| Action | Mutation | Notes |
|---|---|---|
| Trigger a deploy | `environmentTriggersDeploy(input: EnvironmentTriggersDeployInput!)` → `String` (id) | input: `projectId`, `environmentId`, `serviceId` |
| Redeploy | `deploymentRedeploy(id: String!)` → `{ id status }` | redeploy an existing deployment |
| Upsert variable | `variableUpsert(input: VariableUpsertInput!)` | input: `projectId!`, `environmentId!`, `serviceId?`, `name!`, `value!`, `skipDeploys?` — redeploys affected service unless `skipDeploys: true` |
| Rollback / restart / remove | `deploymentRollback`/`deploymentRestart`/`deploymentRemove(id: String!)` | not exposed in V0 (`Remove` is a delete → blocked default) |

- **Deployment status enum:** `INITIALIZING`, `BUILDING`, `DEPLOYING`, `SUCCESS`, `FAILED`, `CRASHED`, `REMOVED`, `REMOVING`, `SKIPPED`, `QUEUED`, `WAITING`, `NEEDS_APPROVAL`, `SLEEPING`. Failure states: `FAILED`, `CRASHED`.
- **Log entry:** `{ timestamp, message, severity }` — we normalize to `{timestamp, level, message}` (severity `err*`→`error`, `warn*`→`warn`, else `info`) and redact secrets.

### GraphQL error handling
- GraphQL typically returns **HTTP 200 with an `errors[]` array** for query-level failures; auth failures can also be `400/401`. The adapter surfaces both as a clean `OfflocalError` (httpJson throws on non-2xx; `gql()` throws on a non-empty `errors[]`).

### Rate limits
- Per-hour by plan: Free 100 RPH, Hobby 1,000 (10 RPS), Pro 10,000 (50 RPS), Enterprise custom. Headers: `X-RateLimit-Remaining/Limit/Reset`, `Retry-After`.

### Safe vs dangerous
- **Safe / read-only:** project context, list deployments, deployment/build logs.
- **Dangerous (gated like Vercel):** `environmentTriggersDeploy`/`deploymentRedeploy` (deploy), `variableUpsert` (env_change). These flow through `runGuarded` with capability `deploy`/`env_change`, so production requires approval by default. `deploymentRemove` (delete) is not exposed (delete is blocked everywhere by default).

### Limitations / TODOs
- V0 surface: reads (context, deployments, logs) + **deploy + variable writes** (gated), matching Vercel's surface. Rollback/restart/remove are future work.
- Project tokens (`Project-Access-Token`) not yet supported — account/workspace token only.
- `deploymentLogs` returns recent runtime logs; very old logs may be unavailable
- `variableUpsert` triggers a redeploy of affected services unless `skipDeploys: true` — exposed via the tool's `skip_deploys` arg.

---

## Render

_Researched against api-docs.render.com (REST reference). 2026-07-09._

### Base URL, auth & resource model
- **Base URL:** `https://api.render.com/v1` — a standard REST API.
- **Auth:** `Authorization: Bearer <RENDER_API_KEY>` (+ `Accept: application/json`) via `RENDER_API_KEY`.
- **Resource model:** owner (workspace, `usr-`/`tea-`) → service (`srv-`) → deploy. A mapping carries `serviceId`; `ownerId` is only needed for the logs endpoint and is auto-resolved from the service when absent.
- **List shape:** list endpoints wrap each item in an object with a `cursor`, e.g. `[{ deploy: {...}, cursor }]`; single-resource reads return the object directly.

### Key endpoints
| Action | Method + Path | Notes |
|---|---|---|
| Get a service | `GET /services/{serviceId}` | public URL is `serviceDetails.url` (web services / static sites); absent for workers, cron jobs, private services |
| List deploys | `GET /services/{serviceId}/deploys` | newest first; `limit` (1–100) |
| Get a deploy | `GET /services/{serviceId}/deploys/{deployId}` | used to poll deploy status |
| Trigger a deploy | `POST /services/{serviceId}/deploys` | body `{ commitId?, clearCache?, imageUrl?, deployMode? }`; 201/202 |
| Service logs | `GET /logs?ownerId=&resource={serviceId}` | **owner-scoped**, needs `ownerId`; `startTime`/`endTime`/`limit`/`level`… ; returns `{ logs, hasMore, nextStartTime }` |
| Upsert env var | `PUT /services/{serviceId}/env-vars/{key}` | body `{ value }` — creates or updates one variable; Render redeploys on change |

- **Deploy status enum:** `created`, `build_in_progress`, `update_in_progress`, `pre_deploy_in_progress` (in progress); `live` (success); `build_failed`, `update_failed`, `pre_deploy_failed`, `canceled`, `deactivated` (failure). The `deploy` orchestrator treats `live` as success and the four `*_failed`/`canceled`/`deactivated` states as failure; everything else is still in progress.
- **Logs are service-scoped, not deploy-scoped** — the `/logs` endpoint filters by resource (the service), so "deployment logs" for Render are the service's recent logs; we report the latest deploy's id/status alongside them.

### Safe vs dangerous
- **Safe / read-only:** get service, list/get deploys, service logs.
- **Dangerous (gated like Vercel/Railway):** `POST .../deploys` (deploy), `PUT .../env-vars/{key}` (env_change). These flow through `runGuarded`, so production requires approval by default. Service delete is not exposed (delete is blocked everywhere by default).

### Limitations / TODOs
- The logs API requires an `ownerId`; we resolve it from the service on demand and cache nothing — if the key can't read the service, we return a clear `limitation` rather than failing.
- Deploy-from-local-files is out of scope; Render deploys are git- or image-backed (trigger a deploy of the connected repo, optionally at a `commitId`).
- Static sites and web services expose `serviceDetails.url`; background workers / private services / cron jobs have no public URL — `deploy` reports success without a URL for those.

---

## MCP

### Overview
MCP is the open standard connecting LLM agents to tools. A **local stdio server** runs as a subprocess of the client (Claude Code, Cursor, Codex) over stdin/stdout JSON-RPC — simplest deployment for dev tooling, no network or auth handshake.

### TypeScript SDK
- **Package:** `@modelcontextprotocol/sdk` (current ~1.29.x). Node ≥ 18, ESM. Peer dep `zod`.
- **High-level API:** `McpServer` + `server.registerTool(name, config, handler)`. Import subpaths use explicit `.js`:
  - `@modelcontextprotocol/sdk/server/mcp.js` → `McpServer`
  - `@modelcontextprotocol/sdk/server/stdio.js` → `StdioServerTransport`
- `inputSchema` / `outputSchema` take a **raw Zod shape** (`{ name: z.string() }`), **not** `z.object({...})`. The SDK wraps it and derives the advertised JSON Schema.

### Minimal stdio server skeleton
```typescript
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "offlocalai-mcp", version: "0.0.1" });

server.registerTool(
  "ping",
  {
    title: "Ping",
    description: "Health-check and echo a message back.",
    inputSchema: { message: z.string().describe("Text to echo back") },
  },
  async ({ message }) => ({
    content: [{ type: "text", text: JSON.stringify({ status: "ok", echo: message }) }],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
// NEVER write to stdout elsewhere — it corrupts JSON-RPC. Log to stderr.
```

### Tool return shape
- Return `{ content: [{ type: "text", text: "..." }] }`. **Always** stringify JSON into a `text` block — universal across clients.
- `structuredContent` is supported but **only valid if you also declared a matching `outputSchema`**. V0 returns JSON-as-text for every tool (varied shapes) and omits `outputSchema`/`structuredContent` to stay universally compatible.
- Signal failure with `isError: true` + an actionable error message in the text block (don't throw raw).

### Auth expectations
- **Local stdio:** no auth handshake — secrets are supplied via the `env` block in the client config (or env vars the server reads at startup). This is offlocal.ai's model.

### Client configuration

**Claude Code** — CLI or project `.mcp.json`:
```bash
claude mcp add --transport stdio offlocalai \
  --env GITHUB_TOKEN=xxx -- npx -y offlocalai-mcp
```
```json
{
  "mcpServers": {
    "offlocalai": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "offlocalai-mcp"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    }
  }
}
```

**Cursor** — `~/.cursor/mcp.json` or `.cursor/mcp.json` (no `type` field):
```json
{
  "mcpServers": {
    "offlocalai": {
      "command": "npx",
      "args": ["-y", "offlocalai-mcp"],
      "env": { "GITHUB_TOKEN": "xxx" }
    }
  }
}
```

**Codex** — `~/.codex/config.toml`:
```toml
[mcp_servers.offlocalai]
command = "npx"
args = ["-y", "offlocalai-mcp"]
env = { GITHUB_TOKEN = "xxx" }
```

### Tool-response best practices
- Return JSON with an explicit `status` field plus a short human-readable summary so the agent can branch deterministically and narrate.
- Use `isError: true` for failures; keep payloads tight; log to **stderr only**.
- `tsconfig`: `"module": "NodeNext"` / `"moduleResolution": "NodeNext"` so `.js` import subpaths resolve.

---

## Cross-cutting V0 decisions

1. **Direct REST, not provider MCPs** — control over auth, policy, routing, audit.
2. **Env-var auth only** (`ProviderAuth`).
3. **Tokens are never persisted** to `.offlocal/` — read from `process.env` at call time.
4. **Policy is capability-based** (read/write/deploy/env_change/delete/destructive_sql) × environment kind × provider, so new tools inherit safe defaults.
5. **Local SQL classification + Supabase `read_only`** = defense in depth.
6. **Every provider action resolves project + environment + policy first, then audits** — no exceptions.
