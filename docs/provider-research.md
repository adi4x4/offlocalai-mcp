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
| Supabase | Personal Access Token | `SUPABASE_ACCESS_TOKEN` |
| Stripe | Secret keys (test+live) | `STRIPE_TEST_SECRET_KEY`, `STRIPE_LIVE_SECRET_KEY` |
| Upstash | Basic auth with email + API key | `UPSTASH_EMAIL`, `UPSTASH_API_KEY` |
| Sentry | Bearer auth token | `SENTRY_AUTH_TOKEN` |
| PostHog | Personal API key | `POSTHOG_PERSONAL_API_KEY` |
| Resend | Bearer API key | `RESEND_API_KEY` |
| Twilio | Account SID + auth token | mapping `accountSid`, env `TWILIO_AUTH_TOKEN` |

---

## GitHub

_Researched against docs.github.com, current as of 2026-06-08._

### REST API basics
- **Base URL:** `https://api.github.com`
- **API version header:** `X-GitHub-Api-Version: 2026-03-10` (latest). If omitted, requests default to `2022-11-28` — always send it explicitly. Unsupported versions return `410 Gone`.
- **Auth header:** `Authorization: Bearer <TOKEN>`. Also send `Accept: application/vnd.github+json`.

### Auth model
- **Fine-grained PAT via `GITHUB_TOKEN`.** No callback flow, least-privilege per repo. Grant **Metadata: read** (mandatory), **Contents: read** for repo context, and **Actions: read** for CI diagnostics; add **Actions: write** only when rerun/cancel tools are enabled. Classic PAT works but is coarser.

### Key endpoints
| Purpose | Method + Path | Permission |
|---|---|---|
| Get repo metadata (incl. `default_branch`) | `GET /repos/{owner}/{repo}` | Metadata: read |
| Get README | `GET /repos/{owner}/{repo}/readme` | Contents: read |
| Get file/dir contents | `GET /repos/{owner}/{repo}/contents/{path}` | Contents: read |
| List branches | `GET /repos/{owner}/{repo}/branches` | Contents: read |
| List workflow runs | `GET /repos/{owner}/{repo}/actions/runs` | Actions: read |
| List workflow jobs | `GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs` | Actions: read |
| Re-run workflow run | `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun` | Actions: write |
| Cancel workflow run | `POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel` | Actions: write |
| List deployments | `GET /repos/{owner}/{repo}/deployments` | Deployments: read |
| Create/update a file (write) | `PUT /repos/{owner}/{repo}/contents/{path}` | Contents: write |
| Delete a file (write) | `DELETE /repos/{owner}/{repo}/contents/{path}` | Contents: write |

Default branch is the `default_branch` field on the repo object (no separate endpoint).

### Rate limits (authenticated)
- PAT / authenticated user: 5,000 req/hour. Secondary limits: ≤100 concurrent, content-creating writes ≤80/min & ≤500/hr. Honor `x-ratelimit-remaining` / `x-ratelimit-reset`.

### Safe vs dangerous
- **Safe (read-only GETs):** get repo, get README, get contents, list branches, list deployments, list workflow runs/jobs.
- **Governed writes:** rerun/cancel workflow runs. These can spend CI minutes or interrupt checks, so they go through DashClaw policy.
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

## Upstash Redis

_Researched against official Upstash Developer API, Redis REST, and QStash REST docs on 2026-06-10._

### Base URL, auth & scoping
- **Developer API base URL:** `https://api.upstash.com/v2`.
- **Auth:** Upstash Developer API uses HTTP Basic auth with username `EMAIL` and password `API_KEY`; store them as `UPSTASH_EMAIL` and `UPSTASH_API_KEY`.
- **QStash API URL:** `https://qstash.upstash.io` by default; region-specific URLs include `https://qstash-us-east-1.upstash.io` and `https://qstash-eu-central-1.upstash.io`.
- **QStash auth:** QStash REST uses `Authorization: Bearer <QSTASH_TOKEN>`.
- **Resource model:** account → Redis database plus QStash region. A mapping stores the non-secret Redis `databaseId`, optional Developer API host override, optional QStash URL, and QStash env-var names.
- **App env model:** applications using `@upstash/redis` consume `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`; a read-only token can be wired as `UPSTASH_REDIS_READ_ONLY_REST_TOKEN` when available.
- **QStash app env model:** applications using QStash consume `QSTASH_URL`, `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, and `QSTASH_NEXT_SIGNING_KEY`. Current/next signing keys let apps verify incoming QStash requests during key rotation.

### Key endpoints
| Action | Method + path | Notes |
|---|---|---|
| List Redis databases | `GET /redis/databases` | account-level read; adapter strips credential-shaped fields if returned |
| Get Redis database | `GET /redis/database/{id}` | returns database details; docs expose `credentials=hide` to remove credentials |
| Create Redis database | `POST /redis/database` | body includes `database_name`, `platform`, `primary_region`, optional `read_regions`, `plan`, `budget`, `eviction`, `tls` |
| Get QStash signing keys | `GET /v2/keys` | returns current and next signing keys for app request verification |
| List QStash schedules | `GET /v2/schedules` | returns cron schedules; adapter strips stored request body/header details |
| Create QStash schedule | `POST /v2/schedules/{destination}` | requires `Upstash-Cron`; adapter sets `Upstash-Redact-Fields: body, headers` |

### Safe vs dangerous
- **Safe/read:** list databases, list QStash schedules, fetch Redis env wiring, and fetch QStash env wiring. Env wiring may include REST tokens or signing keys in the tool result, so summaries and resource labels name only non-secret resources.
- **Governed setup/env change:** create Redis databases and QStash schedules because they provision product infrastructure and return or depend on environment variables intended for app deployment.
- **Secret handling:** never include `UPSTASH_API_KEY`, `UPSTASH_REDIS_REST_TOKEN`, Redis passwords, read-only REST tokens, `QSTASH_TOKEN`, QStash signing keys, QStash schedule bodies, or forwarded headers in audit summaries or DashClaw payloads. List actions return credential-free summaries.

### Limitations / TODOs
- V0 manages Redis database creation/env wiring and QStash schedule/env wiring only. It does not delete databases, change plans, reset passwords, configure backups, publish one-off QStash messages, manage queues/URL groups/DLQ, rotate QStash signing keys, or manage Vector/Search resources.
- The Developer API is only available to native Upstash accounts; marketplace-created accounts may not support it.

---

## Cloudflare R2

_Researched against official Cloudflare R2 and Cloudflare API docs on 2026-06-10._

### Base URL, auth & app env model
- **Cloudflare API base URL:** `https://api.cloudflare.com/client/v4`.
- **Auth:** Cloudflare API token in `Authorization: Bearer <CLOUDFLARE_API_TOKEN>`.
- **Resource model:** account -> R2 bucket. A mapping stores the non-secret `accountId`, optional default `bucketName`, optional `jurisdiction`, and optional public/custom asset URL.
- **App env model:** S3-compatible app clients use `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ENDPOINT`, `R2_REGION=auto`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`. The endpoint is `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`; jurisdictional buckets use `https://<ACCOUNT_ID>.eu.r2.cloudflarestorage.com` or `https://<ACCOUNT_ID>.fedramp.r2.cloudflarestorage.com`.

### Key endpoints
| Action | Method + path | Notes |
|---|---|---|
| List buckets | `GET /accounts/{account_id}/r2/buckets` | returns bucket summaries under `result.buckets` plus `result_info` pagination |
| Create bucket | `POST /accounts/{account_id}/r2/buckets` | body includes `name`, optional `locationHint`, optional `storageClass`; optional `cf-r2-jurisdiction` header |
| List objects | `GET /accounts/{account_id}/r2/buckets/{bucket_name}/objects` | accepts `prefix`, `cursor`, and `per_page`; returns object metadata only |

### Safe vs dangerous
- **Safe/read:** list buckets, list object summaries, and return app env wiring for a mapped bucket. Object listing returns metadata only, not object bodies.
- **Governed setup/env change:** create buckets because this provisions storage and returns environment variables intended for app deployment.
- **Secret handling:** never include `CLOUDFLARE_API_TOKEN`, `R2_ACCESS_KEY_ID`, or `R2_SECRET_ACCESS_KEY` in audit summaries or DashClaw payloads. `get_cloudflare_r2_env` returns app credentials to the calling agent only so they can be set as deployment env vars.

### Limitations / TODOs
- V0 manages bucket creation, bucket/object listing, and env wiring only. It does not upload/download/delete objects, configure CORS, custom domains, lifecycle rules, event notifications, locks, or temporary credentials.
- R2 API-token creation is intentionally not automated in V0; operators create/scoped tokens in Cloudflare and provide env vars to the MCP process.

---

## Sentry

_Researched against official Sentry API docs on 2026-06-10._

### Base URL, auth & org scoping
- **Base URL:** `https://sentry.io/api/0`.
- **Auth:** `Authorization: Bearer <SENTRY_AUTH_TOKEN>`.
- **Token model:** Sentry recommends organization auth tokens from internal integrations for API automation. Store the token in the MCP env block; store non-secret organization/project/team slugs in the provider mapping.
- **Resource model:** organization → team → project → client key. A client key exposes a public DSN used by SDKs as `SENTRY_DSN`; Sentry also returns a secret DSN, which the adapter strips from tool results.

### Key endpoints
| Action | Method + path | Notes |
|---|---|---|
| List organization projects | `GET /organizations/{org}/projects/` | accepts `per_page` and `query` |
| Create project for org | `POST /organizations/{org}/projects/` | body includes `name`, optional `slug`, `platform`, `default_rules` |
| Create project for team | `POST /teams/{org}/{team}/projects/` | used when mapping/input has `teamSlug` |
| List project client keys | `GET /projects/{org}/{project}/keys/` | returns public + secret DSNs; adapter returns public DSN only |
| Create project client key | `POST /projects/{org}/{project}/keys/` | optional `name`, `useCase`, and `rateLimit` |
| List organization releases | `GET /organizations/{org}/releases/` | optional starts-with `query` filter |
| Create organization release | `POST /organizations/{org}/releases/` | requires `version` and `projects`; optional `ref`, `url`, `dateReleased` |
| List release deploys | `GET /organizations/{org}/releases/{version}/deploys/` | returns deploy markers for a release |
| Create release deploy | `POST /organizations/{org}/releases/{version}/deploys/` | requires deploy `environment`; optional `name`, `url`, dates, projects |

### Safe vs dangerous
- **Safe/read:** list projects and client keys after stripping secret DSNs.
- **Governed setup/write:** create projects/client keys because they change production observability wiring and create values intended for environment variables. Create releases as governed writes so they are audited.
- **Deploy evidence:** create deploy markers with the `deploy` capability. A marker for Sentry environment `production` is treated as live so DashClaw is consulted even if the local offlocal environment input is not production.
- **Secret handling:** never write `dsn.secret` or the returned `secret` key to audit, DashClaw context, or tool results. Return only `publicDsn` for `SENTRY_DSN` wiring.

### Limitations / TODOs
- V0 does not manage alert rules, issue assignment, source maps, monitors/crons, or ownership rules.
- Release/deploy markers are explicit tool calls; they are not yet auto-chained after Vercel/Railway deploys.

---

## PostHog

_Researched against official PostHog API docs on 2026-06-10._

### Base URL, auth & scoping
- **Private API hosts:** US Cloud uses `https://us.posthog.com`; EU Cloud uses `https://eu.posthog.com`. Public capture/SDK hosts are `https://us.i.posthog.com` and `https://eu.i.posthog.com`. Self-hosted instances use their own domain.
- **Auth:** private APIs use `Authorization: Bearer <POSTHOG_PERSONAL_API_KEY>`.
- **Token model:** store the personal API key in the MCP env block. Store non-secret organization id, project id, and optional host overrides in the provider mapping.
- **Resource model:** organization → project → feature flags. Project responses include public `api_token` for client SDK wiring and private `secret_api_token` fields; the adapter returns only the public project token.

### Key endpoints
| Action | Method + path | Notes |
|---|---|---|
| List organization projects | `GET /api/organizations/{organization_id}/projects/` | accepts `limit`, `offset`, and `search`; requires `project:read` |
| Create organization project | `POST /api/organizations/{organization_id}/projects/` | accepts `name`, optional product/app/session settings; requires `project:write` |
| Retrieve project | `GET /api/organizations/{organization_id}/projects/{id}/` | used to return client-safe env wiring |
| List feature flags | `GET /api/projects/{project_id}/feature_flags/` | accepts `limit`, `search`, `active`, and `type`; requires `feature_flag:read` |
| Create feature flag | `POST /api/projects/{project_id}/feature_flags/` | accepts `key`, `name`, `filters`, `active`, `tags`; requires `feature_flag:write` |

### Safe vs dangerous
- **Safe/read:** list projects, retrieve client-safe env wiring, and list feature flags. Private project secret fields are stripped.
- **Governed setup/env change:** create projects because the result is intended for app environment variables (`NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST`, `POSTHOG_PROJECT_ID`).
- **Governed write:** create feature flags because they can change product behavior. The offlocal tool creates flags inactive by default; production flag writes require approval by default.
- **Secret handling:** never return `secret_api_token` or `secret_api_token_backup`. The public project token (`api_token`) is returned as `NEXT_PUBLIC_POSTHOG_KEY` because PostHog uses it for public capture and flags endpoints.

### Limitations / TODOs
- V0 does not update/delete feature flags, manage experiments, run HogQL/query API calls, or configure product analytics dashboards.
- Feature-flag creation exposes PostHog's `filters` object directly instead of a full rule builder.

---

## Clerk

_Researched against official Clerk docs and the public Clerk OpenAPI BAPI spec on 2026-06-10._

### Base URL, auth & app env model
- **Backend API base URL:** `https://api.clerk.com/v1`.
- **Auth:** HTTP bearer auth using `CLERK_SECRET_KEY`.
- **Env/model:** store the Secret Key in the MCP env block. Store non-secret `publishableKey`, optional sign-in/sign-up route envs, and optional API/FAPI URL overrides in the provider mapping.
- **Frontend env wiring:** Clerk frontend SDKs use `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`; optional route envs include `NEXT_PUBLIC_CLERK_SIGN_IN_URL`, `NEXT_PUBLIC_CLERK_SIGN_UP_URL`, `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL`, and `NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL`.

### Key endpoints
| Action | Method + path | Notes |
|---|---|---|
| List users | `GET /users` | accepts `limit`, `offset`, and `query`; adapter returns small user summaries and strips metadata |
| List domains | `GET /domains` | returns primary/satellite domains and `frontend_api_url`; used by `get_clerk_app_env` |
| List redirect URLs | `GET /redirect_urls` | accepts `limit` and `offset` |
| Create redirect URL | `POST /redirect_urls` | body `{ "url": "https://..." }` or custom-scheme URL |

### Safe vs dangerous
- **Safe/read:** return client-safe app env wiring, list domains, list redirect URLs, and list user summaries.
- **Governed env change:** create redirect URLs because it changes authentication callback allowlists.
- **Secret handling:** never return or audit `CLERK_SECRET_KEY`. `get_clerk_app_env` returns the secret env var name, not the secret value.
- **PII handling:** user list results can include a primary email for operator identification, but audit/DashClaw summaries do not include user queries, emails, metadata, or returned user payloads.

### Limitations / TODOs
- V0 does not create Clerk applications, manage social/SAML connections, create users, update instance settings, or manage Clerk webhooks.
- Publishable keys are mapped manually because the BAPI endpoints used here do not expose API-key creation/rotation.

---

## Resend

_Researched against official Resend docs on 2026-06-10._

### Base URL, auth & request requirements
- **Base URL:** `https://api.resend.com`.
- **Auth:** `Authorization: Bearer <RESEND_API_KEY>`.
- **User-Agent:** Resend rejects direct HTTP requests without a `User-Agent`; the adapter sends one on every request.
- **Env/model:** store non-secret domain/default sender in the provider mapping; read `RESEND_API_KEY` from env at call time.

### Key endpoints
| Action | Method + path | Notes |
|---|---|---|
| Send email | `POST /emails` | body includes `from`, `to`, `subject`, and `html` and/or `text` |
| List domains | `GET /domains` | returns domain status/capabilities |
| Create domain | `POST /domains` | returns DNS records for SPF/DKIM/tracking |
| Verify domain | `POST /domains/{domainId}/verify` | starts asynchronous verification |

### Safe vs dangerous
- **Safe/read:** list domains and inspect status.
- **Governed env change:** create and verify sending domains because it changes production email/DNS setup.
- **Live external side effects:** sending email reaches real people and can include secrets or PII. Treat it as a `live` write even in staging. Do not place recipients, subject, HTML, or text bodies in audit summaries or DashClaw payloads.

### Limitations / TODOs
- V0 does not manage audiences, broadcasts, templates, API keys, inbound emails, or webhooks.
- Add stronger email-address validation and attachment controls before expanding send scope.

---

## Twilio

_Researched against official Twilio docs on 2026-06-10._

### Base URL, auth & account scoping
- **Base URL:** `https://api.twilio.com/2010-04-01`.
- **Auth:** HTTP Basic auth, username = Account SID, password = auth token.
- **Env/model:** store non-secret `accountSid` in the provider mapping; read `TWILIO_AUTH_TOKEN` from env at call time. Do not persist the auth token.

### Key endpoints (bodies are form-encoded)
| Action | Method + path | Notes |
|---|---|---|
| List phone numbers | `GET /Accounts/{AccountSid}/IncomingPhoneNumbers.json` | returns configured numbers and webhook URLs |
| Update phone number webhooks | `POST /Accounts/{AccountSid}/IncomingPhoneNumbers/{PhoneNumberSid}.json` | fields `SmsUrl`, `VoiceUrl` |
| Send SMS | `POST /Accounts/{AccountSid}/Messages.json` | fields `To`, `Body`, plus `From` or `MessagingServiceSid` |
| Create voice call | `POST /Accounts/{AccountSid}/Calls.json` | fields `To`, `From`, `Url` |

### Safe vs dangerous
- **Safe/read:** list phone numbers and inspect configured webhook URLs.
- **Governed env change:** update inbound SMS/voice webhook URLs.
- **Live external side effects:** sending SMS and creating calls cost money and contact real people. Treat them as `live` writes even in staging. Do not place message bodies or recipient phone numbers in audit summaries or DashClaw payloads.

### Limitations / TODOs
- V0 does not purchase Twilio numbers, manage messaging services, or read message/call logs.
- Add stronger E.164 validation and compliance guidance before expanding beyond test/operator-owned numbers.

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
