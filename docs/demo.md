# Demo

Short, copy-pasteable prompts to try against the offlocalai MCP server once a
project is configured (see the README for setup).

## Fetch the latest staging logs

> "Use offlocal.ai to fetch the latest staging logs."

Expected behavior:

1. offlocal.ai resolves the project / environment (`staging`).
2. It finds the mapped Vercel project for that environment.
3. It fetches the **latest deployment's** logs (`get_latest_deployment_logs`, or
   `get_app_logs` with no `provider`).
4. It returns the deployment id/url/status plus normalized log lines to the
   agent — or, if the API can't return log lines, the deployment status plus a
   clear `limitation` (it never fabricates logs).
5. It writes an audit entry for the read (`.offlocal/audit.log`).

Log reads are allowed by default in every environment (including production);
recognizable secrets are redacted from log lines, and every read is audited.
Production **writes / deploys / env changes** remain approval-required.
