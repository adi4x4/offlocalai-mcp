# Launch playbook — domain to production, governed end-to-end

The golden path for shipping a product with the offlocal tools: buy the
domain, deploy on Vercel, provision the database on Neon, wire Stripe, verify.
Every step names the **exact tool** and says what to expect. Steps marked
**(APPROVAL)** pause until a human approves — in the DashClaw UI when DashClaw
is configured, otherwise via `approve_action`.

Prerequisites: env vars from [.env.example](../.env.example) set in your MCP
client's `env` block; a project + environment created (`create_project`,
`add_environment`); Namecheap enablement done (see the last section).

## The golden path

1. **`check_domain_availability`** — pass `domains: ["yourname.com"]`.
   Returns availability, premium status, and pricing. Free; run as often as
   you like.

2. **`purchase_domain` (APPROVAL — always)** — registers the domain and
   spends real money. The `purchase` capability cannot be policy-allowed; a
   human approves every purchase. Needs the `namecheap.registrant` config
   block (below) — the tool tells you exactly what's missing otherwise.
   Start with `NAMECHEAP_SANDBOX=true` to rehearse without charges.

3. **`create_vercel_project`** — pass `name` (and optionally `framework`,
   e.g. `nextjs`). Then map it so later steps target it:
   `map_provider_resource` with the returned project id.

4. **`add_vercel_domain`** — attaches the domain to the Vercel project. The
   result includes `dnsTarget` — the exact record to create at Namecheap
   (apex: `A @ 76.76.21.21`; subdomain: `CNAME www cname.vercel-dns.com`) —
   plus any TXT `verification` challenges.

5. **`set_dns_records` (APPROVAL in production)** — create the records from
   step 4. **WARNING: this REPLACES ALL host records for the domain.** Run
   `get_dns_records` first and resend every record you want to keep.

6. **`create_neon_project`** — provisions a Postgres database. The result
   includes the **connection URI (DATABASE_URL) with credentials — shown here
   only, never in the audit log**. Need it again later (or for another
   branch/role)? `get_neon_connection_uri`.

7. **`set_vercel_env_var`** — key `DATABASE_URL`, value from step 6, target
   `production` (APPROVAL in production by default).

8. **`create_vercel_deployment` (APPROVAL in production)** — deploy the app.

9. **`create_stripe_product`** then **`create_stripe_price`** — test mode is
   allowed by default; **live mode requires approval**.

10. **`create_stripe_webhook`** — pass your endpoint URL (e.g.
    `https://yourname.com/api/stripe/webhook`) and `enabled_events`. The
    result contains the **`whsec_` signing secret exactly once — Stripe never
    shows it again.** Store it immediately:

11. **`set_vercel_env_var`** — key `STRIPE_WEBHOOK_SECRET`, value from step
    10. Redeploy if your framework inlines env vars at build time.

12. **Verify** — `get_vercel_deployment_status` until `READY`, then
    `get_app_logs` for runtime errors and `list_stripe_webhooks` to confirm
    the endpoint is `enabled`. `get_project_context` summarizes the whole
    environment in one call.

## Namecheap enablement (one-time)

API access is **not on by default**, and accounts must meet one of
Namecheap's eligibility bars: 20+ domains, **or** $50+ account balance,
**or** $50+ spent in the last two years.

1. Enable: namecheap.com → **Profile → Tools → API Access** → toggle on →
   copy the API key.
2. **Whitelist your public IP** on the same page. Find it with
   `curl ifconfig.me`. Residential IPs rotate — when calls suddenly fail with
   **error 1011102**, your IP changed: re-whitelist the new one and update
   `NAMECHEAP_CLIENT_IP`. (The tools tell you exactly this when it happens.)
3. **Sandbox** (recommended until you're ready to spend): separate account at
   **sandbox.namecheap.com**, with its own API key and its own IP whitelist.
   Set `NAMECHEAP_SANDBOX=true` to target it — purchases are free rehearsals.
4. Env vars: `NAMECHEAP_API_USER` (account username), `NAMECHEAP_API_KEY`,
   `NAMECHEAP_CLIENT_IP`, `NAMECHEAP_SANDBOX`.
5. Registrant contact for purchases — add to `.offlocal/config.yaml`
   (placeholders, obviously):

```yaml
namecheap:
  registrant:
    first_name: Ada
    last_name: Lovelace
    address1: 123 Main St
    city: Anytown
    state_province: CA
    postal_code: "12345"
    country: US
    phone: "+1.5551234567"      # Namecheap format: +NNN.NNNNNNNNNN
    email_address: you@example.com
```

## When something pauses

A paused step returns `status: "approval_required"` with a reason. Approve in
the DashClaw UI (or `approve_action` with the returned id when running
without DashClaw), then **re-run the same tool** — approval never executes
anything by itself. If a risky step errors with "DashClaw unavailable", that
is fail-closed working as intended: bring DashClaw back (or set
`DASHCLAW_BASE_URL`) and retry.
