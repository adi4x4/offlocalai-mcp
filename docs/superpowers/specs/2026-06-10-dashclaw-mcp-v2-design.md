# DashClaw MCP v2 — governed shipping (merge + launch plans)

**Date:** 2026-06-10
**Status:** Approved (brainstorm with Wes, this session)
**Source repo:** `C:\Projects\offlocalai-mcp` (fork of `adi4x4/offlocalai-mcp`, branch `ucsandman/offlocal-improvements-dashclaw`)
**Destination repo:** `C:\Projects\dashclaw` (monorepo, `mcp-server/` package = `@dashclaw/mcp-server`, currently v1.0.3)

## Context and decision

The offlocalai-mcp fork has diverged 17 commits (+17,427/−688 across 61 files) from upstream, and the core of that work wires the server to DashClaw as authoritative governance — a direction upstream will never merge (PR #1, open since 2026-06-09, zero engagement). Decision: **close the PR, absorb this codebase into `@dashclaw/mcp-server` as v2.0.0**, and build the launch-plans feature in the new home.

Product thesis: the launch tail (domain → DNS → deploy → DB → Stripe → email → env wiring) is the part of shipping AI agents can't safely do alone. DashClaw v2 = guard + governed execution + stateful launch plans.

Merge direction: `@dashclaw/mcp-server` today is 1,308 lines of hand-written plain JS (`lib/server.js`, `client.js`, `tools.js`, `resources.js` — guard/record/invoke/capabilities + resources). The offlocal codebase is ~17k lines of TypeScript with storage, policy engine, 15 provider adapters, CLI, and 251 tests. **The TS codebase becomes the v2 source; the 4 JS files are ported into it as TS modules.** Do not port TS into JS.

## Part 1 — Transition

1. **Phase 0 (source repo):** if the working tree still has uncommitted changes (`src/service.ts`, `test/operations.test.ts`, `test/providers.test.ts` — credential env-var coverage; all 251 tests pass as of 2026-06-10), commit them on the current branch. Run `npm run verify` and confirm green before migrating anything.
2. **Close PR #1** on `adi4x4/offlocalai-mcp` with a courteous note: the work grew into a DashClaw-platform-specific direction that doesn't belong upstream; withdrawing rather than asking upstream to absorb a platform dependency. Code remains Apache-2.0 on the fork.
3. **Migrate** the codebase into `C:\Projects\dashclaw\mcp-server`:
   - TS source in `src/`, compiled output in `lib/` (preserve the existing `main`/`exports`/`bin` shape; `bin` stays `dashclaw-mcp`).
   - Port `server.js`/`client.js`/`tools.js`/`resources.js` to TS modules; register the governance tools (guard, record, invoke, capabilities, resources) alongside the provider tools in one server.
   - Version → **2.0.0** (breaking: tool surface expands ~25 → ~110).
   - Keep the vitest suite; all tests must pass in the new home.
   - **Separate move commits from change commits** so regressions are bisectable.
4. **Licensing:** merged package is **Apache-2.0**. DashClaw owns the existing MIT code and relicenses it; Apache-licensed code keeps its headers; add a NOTICE file crediting the original `offlocalai-mcp` project (adi4x4).
5. **Rebrand (trademark-clean, no "offlocal" anywhere):**
   - Env vars `OFFLOCAL_*` → `DASHCLAW_*`. No back-compat aliases (sole user is Wes).
   - Storage dir `.offlocal/` → `.dashclaw-local/` — verify no collision with anything DashClaw agents already write before finalizing the name.
   - CLI `offlocal …` → `dashclaw …` subcommands.
   - MCP tool names that don't mention offlocal stay unchanged.
6. **Conditional tool registration:** register a provider's tools only when its credential env var(s) are present. No token → tools not registered. Keeps connecting agents' context lean (~110 tools would otherwise load into every session).
7. After migration is verified, archive the fork repo (do not delete).

## Part 2 — Launch plans

A launch is a first-class local object (stored like projects/approvals, JSON under the local state dir). Steps execute through the **existing guarded tools** — policy, the DashClaw gate, approvals, and audit apply per-step, unchanged. Plans track; they never bypass.

- **`create_launch_plan`** — input: project + declared stack (subset of: domain/namecheap, vercel, neon, stripe products+prices, resend, clerk, upstash, r2, sentry, posthog). Output: ordered step checklist derived from the launch-playbook golden path (`docs/launch-playbook.md`).
- **`get_launch_status`** — steps done / pending / blocked-on-approval / failed, plus the single next action. Resumable across sessions; survives approval interruptions.
- **Completion is verified, not self-reported:** each step declares a reality check (e.g. "Vercel project mapped", "DNS contains records X", "Stripe price exists") and `get_launch_status` evaluates it against provider/local state, so a crashed session can't leave phantom "done" marks. Reality checks are reads (allowed by default, audited).
- **`preflight_launch`** — before step 1: required tokens present and valid for the declared stack, mappings complete, Stripe mode sanity, Namecheap client IP whitelisted. Run before any money is spent.
- **`verify_launch`** — after the last step: domain resolves, latest deployment READY, required env vars present on the app, Stripe webhook responding, email domain verified.
- Launch-plan state is **local only** in this phase. DashClaw-dashboard surfacing is explicitly out of scope until real launches have produced feedback.
- Tests: unit tests for plan generation per stack shape, status/reality-check evaluation, preflight failure modes; integration tests through the guarded-action path (mirroring the existing test patterns).

## Sequencing

1. Phase 0: land in-flight work in source repo, verify green.
2. Close PR #1.
3. Migration + rebrand into `dashclaw/mcp-server`; full suite green in the new home; docs (README, env table, tool catalog) updated for the DashClaw identity.
4. Launch plans + preflight/verify, with tests and docs.
5. Wes runs the ship-everything launch sweep; that feedback defines v2.1. (Out of scope here.)

## Risks

- Migration touches every import path and build/test config — mechanical but wide; mitigated by move-vs-change commit separation and the test suite.
- v2.0.0 is a breaking npm release; acceptable since all consumers are Wes-controlled. **Do not publish to npm without explicit confirmation.**
- Conditional tool registration changes startup behavior; needs tests (token present/absent → tools registered/absent).

## Definition of done

- `npm run verify` (or destination-repo equivalent: typecheck + tests + build) green in `dashclaw/mcp-server`.
- No string `offlocal` remains in the migrated package (code, docs, env vars, storage paths) except the NOTICE/attribution.
- PR #1 closed with the courteous note; fork archived.
- Launch-plan tools registered, tested, documented in the package README.
- No secrets in any commit.
