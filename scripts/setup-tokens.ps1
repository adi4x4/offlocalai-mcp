# One-time provider-token setup for the offlocal MCP server (Windows).
#
#   powershell -File scripts/setup-tokens.ps1
#
# Stores each token as a USER environment variable - set once, available in
# every project and every agent session on this machine. Press Enter to skip
# anything you don't use; blank input never overwrites an existing value.
# Re-run any time to add or rotate tokens.
# (ASCII-only on purpose: Windows PowerShell 5.1 misreads UTF-8 without BOM.)

$vars = [ordered]@{
  GITHUB_TOKEN           = "GitHub fine-grained PAT  (github.com -> Settings -> Developer settings -> Tokens)"
  VERCEL_TOKEN           = "Vercel token  (vercel.com -> Account Settings -> Tokens)"
  VERCEL_TEAM_ID         = "Vercel team id  (only if your projects live in a team)"
  SUPABASE_ACCESS_TOKEN  = "Supabase personal access token  (supabase.com -> Account -> Access Tokens)"
  STRIPE_TEST_SECRET_KEY = "Stripe TEST secret key sk_test_...  (dashboard.stripe.com -> Developers -> API keys)"
  STRIPE_LIVE_SECRET_KEY = "Stripe LIVE secret key sk_live_...  (optional; live writes need approval anyway)"
  RAILWAY_TOKEN          = "Railway account token  (railway.app -> Account Settings -> Tokens)"
  NEON_API_KEY           = "Neon API key  (console.neon.tech -> Account settings -> API keys)"
  UPSTASH_EMAIL          = "Upstash account email  (used with UPSTASH_API_KEY for Developer API)"
  UPSTASH_API_KEY        = "Upstash Developer API key  (console.upstash.com -> Account -> Management API)"
  QSTASH_TOKEN           = "Upstash QStash token  (for background jobs, cron schedules, and delivery)"
  QSTASH_CURRENT_SIGNING_KEY = "QStash current signing key  (for verifying incoming QStash requests)"
  QSTASH_NEXT_SIGNING_KEY = "QStash next signing key  (for zero-downtime signing-key rotation)"
  CLOUDFLARE_API_TOKEN   = "Cloudflare API token  (R2 bucket management)"
  R2_ACCESS_KEY_ID       = "Cloudflare R2 S3-compatible access key id  (app env wiring)"
  R2_SECRET_ACCESS_KEY   = "Cloudflare R2 S3-compatible secret access key  (app env wiring)"
  SENTRY_AUTH_TOKEN      = "Sentry auth token  (internal integration token for org/project setup)"
  POSTHOG_PERSONAL_API_KEY = "PostHog personal API key  (project env and feature-flag APIs)"
  CLERK_SECRET_KEY       = "Clerk Secret Key  (Backend API key; publishable key is mapped per environment)"
  RESEND_API_KEY         = "Resend API key  (transactional email and domain setup)"
  TWILIO_AUTH_TOKEN      = "Twilio auth token  (paired with mapped accountSid for SMS/voice)"
  NAMECHEAP_API_USER     = "Namecheap account USERNAME (not the key)"
  NAMECHEAP_API_KEY      = "Namecheap API key  (Profile -> Tools -> API Access; must be enabled)"
  NAMECHEAP_CLIENT_IP    = "Your current public IP  (run: curl ifconfig.me) - must be whitelisted in API Access"
  NAMECHEAP_SANDBOX      = "true = practice mode, no real charges (separate signup at sandbox.namecheap.com)"
  DASHCLAW_BASE_URL      = "DashClaw base URL, e.g. http://localhost:3000  (governance gate)"
  DASHCLAW_API_KEY       = "DashClaw workspace API key"
}

Write-Host ""
Write-Host "offlocal token setup - enter a value to save it, or just press Enter to skip." -ForegroundColor Cyan
Write-Host "Values are saved as USER environment variables on this machine only."
Write-Host ""

foreach ($name in $vars.Keys) {
  $current = [Environment]::GetEnvironmentVariable($name, "User")
  if (-not $current) { $current = [Environment]::GetEnvironmentVariable($name, "Machine") }
  $status = if ($current) { "already set - Enter keeps it" } else { "not set" }
  Write-Host ("{0}  [{1}]" -f $name, $status) -ForegroundColor Yellow
  Write-Host ("  {0}" -f $vars[$name]) -ForegroundColor DarkGray
  $value = Read-Host "  value"
  if ($value -and $value.Trim()) {
    [Environment]::SetEnvironmentVariable($name, $value.Trim(), "User")
    Write-Host "  saved" -ForegroundColor Green
  }
  Write-Host ""
}

Write-Host "Done. Close this terminal AND restart Claude Code (new processes only see new values)." -ForegroundColor Cyan
Write-Host "Then, in any project, ask your agent: 'run the offlocal doctor' to confirm what's configured."
