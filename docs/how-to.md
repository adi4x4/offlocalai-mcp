# How-to: from zero to a governed launch in ~15 minutes

A hands-on walkthrough for first-time users. No prior MCP knowledge needed —
if you want the concepts first, read [architecture.md](architecture.md) (5
minutes); if you want the full production launch sequence, that's
[launch-playbook.md](launch-playbook.md). This doc gets you running and shows
you the guardrails actually working.

## What you're setting up

A local MCP server that gives your AI agent (Claude Code, Cursor, Codex)
**governed** access to GitHub, Vercel, Supabase, Stripe, Railway, Neon, and
Namecheap. Reads are free; risky actions need approval; spending money
**always** needs a human. Everything is audited.

## Step 1 — Install

**Option A (released version):** nothing to install — the `.mcp.json` below
runs it from npm via `npx`.

**Option B (this repo / from source):**

```bash
git clone <this repo>
cd offlocalai-mcp
npm install
npm run build
```

## Step 2 — Connect it to your agent

Create `.mcp.json` in your project root (Claude Code; Cursor/Codex variants in
the [README](../README.md#step-1--add-offlocal-to-your-ai-agent)):

```json
{
  "mcpServers": {
    "offlocal": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/path/to/offlocalai-mcp/dist/index.js"],
      "env": {
        "GITHUB_TOKEN": "your_github_pat",
        "VERCEL_TOKEN": "your_vercel_token"
      }
    }
  }
}
```

(For the npm version use `"command": "npx", "args": ["-y", "-p", "@offlocal/mcp", "offlocal-mcp"]`.)

Only add tokens for providers you actually use — see
[.env.example](../.env.example) for the full list with instructions per
provider. Restart your agent after editing.

## Step 3 — Say hello

In your agent, ask:

> "Use the offlocal doctor tool and tell me what's configured."

`doctor` reports which providers have credentials, what's mapped, and whether
the audit log is writable. Then set up a project by just describing it:

> "Create an offlocal project called my-app with a production environment,
> and map it to my GitHub repo me/my-app and Vercel project my-app."

## Step 4 — See the guardrails before you trust them

These three commands prove the governance is real, without touching anything:

1. **"Check policy: can you deploy to production?"** (`check_policy`) →
   `approval_required`. Writes to production never just happen.
2. **"Simulate deleting a resource."** (`simulate_action`) → `block`.
   Deletes are blocked everywhere by default.
3. **"Check whether purchasing a domain would be allowed if you set an allow
   policy for it."** → still `approval_required`. The `purchase` capability is
   clamped — no policy can un-gate spending money. By design.

Now trigger one for real: ask the agent to set a production env var. It will
come back with `approval_required` and an approval id. Approve it (DashClaw UI
if configured, otherwise `approve_action`), ask the agent to re-run, and then:

> "Show me the audit log."

Every attempt is there — including the one that was paused.

## Step 5 — Test the new launch tools without spending a cent

- **Domains (Namecheap sandbox):** sign up at sandbox.namecheap.com (separate
  account), enable API access, whitelist your IP (`curl ifconfig.me`), set
  `NAMECHEAP_SANDBOX=true`. Now `check_domain_availability` and even
  `purchase_domain` are free rehearsals — purchase still demands approval, so
  you get to experience the full flow.
- **Database (Neon):** the free tier is enough. `create_neon_project` returns
  a real `DATABASE_URL` — note it appears in the tool result but **not** in
  the audit log.
- **Stripe:** test mode (`STRIPE_TEST_SECRET_KEY`) — `create_stripe_webhook`
  returns the `whsec_` signing secret exactly once; store it immediately.

## Step 6 — The real thing

Follow [launch-playbook.md](launch-playbook.md): domain → DNS → Vercel →
Neon → env vars → deploy → Stripe products + webhook → verify. Each step names
the exact tool and tells you where it will pause for approval.

## Verifying a checkout (for contributors)

```bash
npm run verify   # typecheck + build + full test suite + npm audit — must exit 0
```

All provider HTTP is mocked in tests; `npm run verify` never calls a real API
and needs no credentials.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Namecheap error **1011102** | Your public IP changed. Re-whitelist it (Profile → Tools → API Access) and update `NAMECHEAP_CLIENT_IP`. |
| "DashClaw unavailable; refusing risky action" | Fail-closed working as intended. Start DashClaw / set `DASHCLAW_BASE_URL`, or accept that risky actions stay off without it. |
| "X is not set" errors | The message names the exact env var or config block to add. Add it to your `.mcp.json` `env` block and restart the agent. |
| Domain purchase fails with a registrant message | Add the `namecheap.registrant` block to `.offlocal/config.yaml` — example in the [playbook](launch-playbook.md#namecheap-enablement-one-time). |
