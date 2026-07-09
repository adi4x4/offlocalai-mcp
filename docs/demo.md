# Example prompts

Prompts to try against the server once a project is configured. See the README
for setup.

## Deploy to staging

> Use offlocal to deploy acme-crm to staging.

What happens:

1. The project and environment (`staging`) are resolved.
2. The deploy target mapped to that environment is selected (Vercel, Railway, or
   Render; pass `provider` if more than one is mapped).
3. `deploy` triggers the deployment through the guarded flow, so the attempt is
   policy-checked and audited.
4. It polls until the build reaches a terminal state and returns:
   - success: `{ "status": "deployed", "url": "https://..." }`
   - failure: `{ "status": "failed", "logs": [ ... ] }`
5. A production deploy returns `{ "status": "approval_required" }` and does not
   execute. Add an allow rule with `set_policy_rule`, then rerun.

## Fetch the latest staging logs

> Use offlocal to fetch the latest staging logs.

What happens:

1. The project and environment (`staging`) are resolved.
2. The mapped provider for that environment is found.
3. The latest deployment's logs are fetched (`get_latest_deployment_logs`, or
   `get_app_logs` with no `provider`).
4. It returns the deployment id, URL, and status plus normalized log lines. If
   the provider API cannot return log lines, it returns the deployment status and
   a `limitation` field instead.
5. The read is written to the audit log.

Log reads are allowed in every environment. Recognizable secrets are redacted
from log lines. Production writes, deploys, and env-var changes remain
approval-required.
