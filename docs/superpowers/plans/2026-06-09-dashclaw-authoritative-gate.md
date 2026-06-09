# DashClaw Authoritative Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DashClaw the authoritative guard and evidence ledger for risky offlocal provider actions.

**Architecture:** Add a focused `src/dashclaw/` adapter layer, keep `runGuarded()` as the only provider execution choke point, and store DashClaw correlation metadata in local audit entries. Risky actions fail closed when DashClaw cannot decide; read actions keep the current local policy/audit path.

**Tech Stack:** TypeScript ESM, Vitest, Node 18+ global `fetch`, existing offlocal `Store`, `runGuarded()`, MCP tool registration via Zod schemas.

---

## File Structure

- Create `src/dashclaw/types.ts`: normalized DashClaw config, guard payload, decision, outcome, status, and evidence types.
- Create `src/dashclaw/client.ts`: DashClaw HTTP client using `DASHCLAW_BASE_URL`, `DASHCLAW_API_KEY`, `DASHCLAW_TIMEOUT_MS`, timeout handling, and secret-redacted errors.
- Create `src/dashclaw/guard.ts`: offlocal `ActionContext` to DashClaw guard payload mapping, risky-action detection, risk scoring, decision normalization, and SQL fingerprint helper.
- Create `src/dashclaw/evidence.ts`: outcome recording plus recent decision and status helpers.
- Modify `src/types.ts`: add optional DashClaw metadata fields to `AuditLogEntry`.
- Modify `src/actions.ts`: call DashClaw inside `runGuarded()` for risky actions before provider execution; preserve local audit exactly once.
- Modify `src/service.ts`: add `dashclawStatus()`, `dashclawRecentDecisions()`, `exportDashclawEvidence()`, `explainActionRisk()`, and `governedActionSummary()`.
- Modify `src/tools/index.ts`: register MCP tools for DashClaw status, recent decisions, evidence export, risk explanation, and governed summaries.
- Modify `src/cli.ts`: add optional `offlocal dashclaw status` and `offlocal dashclaw evidence` commands.
- Modify `.env.example` and `README.md`: document DashClaw env vars and the Governed Infrastructure Actions product surface.
- Create `test/dashclaw.test.ts`: adapter, mapping, decision normalization, fail-closed, and secret-safety tests.
- Modify `test/actions.test.ts`: direct `runGuarded()` invariants for DashClaw allow/block/approval/unavailable/outcome failure.
- Modify `test/tools.test.ts` and `test/cli.test.ts`: schema and CLI coverage.
- Modify `test/operations.test.ts`: service-level DashClaw status/evidence tests.

---

### Task 1: DashClaw Adapter Foundation

**Files:**
- Create: `src/dashclaw/types.ts`
- Create: `src/dashclaw/client.ts`
- Create: `test/dashclaw.test.ts`

- [x] **Step 1: Write failing adapter tests**

Add this initial test block to `test/dashclaw.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { dashclawConfigFromEnv, dashclawFetch } from "../src/dashclaw/client.js";
import { normalizeDashclawDecision } from "../src/dashclaw/guard.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DASHCLAW_BASE_URL;
  delete process.env.DASHCLAW_API_KEY;
  delete process.env.DASHCLAW_TIMEOUT_MS;
});

describe("DashClaw client", () => {
  it("reads env config without storing secrets", () => {
    process.env.DASHCLAW_BASE_URL = "https://dashclaw.example";
    process.env.DASHCLAW_API_KEY = "dc_secret";

    const config = dashclawConfigFromEnv();

    expect(config).toMatchObject({
      baseUrl: "https://dashclaw.example",
      apiKey: "dc_secret",
      timeoutMs: 30000,
      mode: "authoritative",
    });
  });

  it("fails clearly when required env vars are missing", () => {
    expect(() => dashclawConfigFromEnv()).toThrow(/DASHCLAW_BASE_URL/i);
  });

  it("sends x-api-key and redacts secrets in HTTP errors", async () => {
    process.env.DASHCLAW_BASE_URL = "https://dashclaw.example";
    process.env.DASHCLAW_API_KEY = "dc_secret";
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "bad key dc_secret" }), {
        status: 403,
        statusText: "Forbidden",
      }),
    ));

    await expect(dashclawFetch("/api/guard", { method: "POST", body: { action_type: "provider_deploy" } }))
      .rejects.toThrow(/REDACTED/);

    expect(fetch).toHaveBeenCalledWith(
      "https://dashclaw.example/api/guard",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-api-key": "dc_secret" }),
      }),
    );
  });
});

describe("DashClaw decision normalization", () => {
  it.each([
    ["allow", "allow"],
    ["block", "block"],
    ["require_approval", "require_approval"],
    ["approval_required", "require_approval"],
  ] as const)("normalizes %s", (input, expected) => {
    expect(normalizeDashclawDecision(input)).toBe(expected);
  });

  it("rejects unknown decisions loudly", () => {
    expect(() => normalizeDashclawDecision("unsupported_decision")).toThrow(/unknown DashClaw decision/i);
  });
});
```

- [x] **Step 2: Run the adapter tests and verify they fail**

Run:

```powershell
npm test -- test/dashclaw.test.ts
```

Expected: fail because `src/dashclaw/client.ts` and `src/dashclaw/guard.ts` do not exist.

- [x] **Step 3: Add DashClaw types**

Create `src/dashclaw/types.ts`:

```ts
export type DashclawDecision = "allow" | "block" | "require_approval";

export interface DashclawConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  mode: "authoritative";
}

export interface DashclawGuardPayload {
  action_type: string;
  declared_goal: string;
  systems_touched: string[];
  reversible: boolean;
  risk_score: number;
  metadata: Record<string, unknown>;
}

export interface DashclawGuardDecision {
  decision: DashclawDecision;
  reason: string;
  decisionId?: string;
  actionId?: string;
  verificationStatus?: string;
  signals?: unknown;
  raw: unknown;
}

export interface DashclawOutcomeInput {
  actionId: string;
  status: "success" | "error" | "not_executed";
  durationMs: number;
  summary: string;
  metadata: Record<string, unknown>;
  errorMessage?: string;
}

export interface DashclawStatusReport {
  configured: boolean;
  baseUrl?: string;
  mode: "authoritative";
  reachable: boolean;
  error?: string;
}
```

- [x] **Step 4: Add the DashClaw HTTP client**

Create `src/dashclaw/client.ts`:

```ts
import { OfflocalError } from "../util.js";
import type { DashclawConfig } from "./types.js";

const DEFAULT_DASHCLAW_TIMEOUT_MS = 30_000;

function redact(text: string, apiKey?: string): string {
  let out = text.replace(
    /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_?KEY|ACCESS_TOKEN)[A-Z0-9_]*)\s*[=:]\s*("?)[^\s",}]+\2/gi,
    "$1=***REDACTED***",
  );
  if (apiKey) out = out.split(apiKey).join("***REDACTED***");
  return out;
}

function readTimeout(): number {
  const raw = process.env.DASHCLAW_TIMEOUT_MS ?? process.env.OFFLOCAL_HTTP_TIMEOUT_MS ?? String(DEFAULT_DASHCLAW_TIMEOUT_MS);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new OfflocalError("DASHCLAW_TIMEOUT_MS must be a positive integer number of milliseconds.");
  }
  return parsed;
}

export function dashclawConfigFromEnv(): DashclawConfig {
  const baseUrl = process.env.DASHCLAW_BASE_URL?.trim();
  if (!baseUrl) throw new OfflocalError("DASHCLAW_BASE_URL is required for DashClaw authoritative mode.");
  const apiKey = process.env.DASHCLAW_API_KEY?.trim();
  if (!apiKey) throw new OfflocalError("DASHCLAW_API_KEY is required for DashClaw authoritative mode.");
  const mode = process.env.OFFLOCAL_DASHCLAW_MODE ?? "authoritative";
  if (mode !== "authoritative") {
    throw new OfflocalError('OFFLOCAL_DASHCLAW_MODE must be "authoritative" for this version.');
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, timeoutMs: readTimeout(), mode };
}

export async function dashclawFetch<T = unknown>(
  path: string,
  opts: { method?: string; body?: unknown; query?: Record<string, string | undefined> } = {},
): Promise<T> {
  const config = dashclawConfigFromEnv();
  const url = new URL(path, `${config.baseUrl}/`);
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined && value !== "") url.searchParams.set(key, value);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: opts.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": config.apiKey,
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    const message = controller.signal.aborted
      ? `Timed out after ${config.timeoutMs}ms calling DashClaw.`
      : `Network error calling DashClaw: ${err instanceof Error ? err.message : String(err)}`;
    throw new OfflocalError(redact(message, config.apiKey));
  }
  clearTimeout(timeout);

  const text = await response.text();
  const parsed = text ? safeJson(text) : undefined;
  if (!response.ok) {
    const detail = typeof parsed === "string" ? parsed : JSON.stringify(parsed ?? {});
    throw new OfflocalError(redact(`${response.status} ${response.statusText} from DashClaw: ${detail}`, config.apiKey));
  }
  return parsed as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
```

- [x] **Step 5: Add initial decision normalizer**

Create `src/dashclaw/guard.ts`:

```ts
import { OfflocalError } from "../util.js";
import type { DashclawDecision } from "./types.js";

export function normalizeDashclawDecision(value: unknown): DashclawDecision {
  if (value === "allow") return "allow";
  if (value === "block") return "block";
  if (value === "require_approval" || value === "approval_required") return "require_approval";
  throw new OfflocalError(`Unknown DashClaw decision "${String(value)}".`);
}
```

- [x] **Step 6: Run tests and commit**

Run:

```powershell
npm test -- test/dashclaw.test.ts
npm run typecheck
```

Expected: both pass.

Commit:

```powershell
git add src/dashclaw/types.ts src/dashclaw/client.ts src/dashclaw/guard.ts test/dashclaw.test.ts
git commit -m "feat: add dashclaw client foundation"
```

---

### Task 2: Guard Payload Mapping and Secret-Safe Risk Context

**Files:**
- Modify: `src/dashclaw/guard.ts`
- Modify: `test/dashclaw.test.ts`

- [x] **Step 1: Add failing payload mapping tests**

Append to `test/dashclaw.test.ts`:

```ts
import { createHash } from "node:crypto";
import { buildDashclawGuardPayload, isRiskyAction, sqlFingerprint } from "../src/dashclaw/guard.js";
import type { ActionContext, PolicyDecision } from "../src/types.js";

function actionContext(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    project: {
      id: "proj_1",
      workspaceId: "ws_1",
      slug: "acme-crm",
      name: "Acme CRM",
      createdAt: "2026-06-09T00:00:00.000Z",
    },
    environment: {
      id: "env_1",
      projectId: "proj_1",
      name: "production",
      kind: "production",
      isProduction: true,
      createdAt: "2026-06-09T00:00:00.000Z",
    },
    provider: "vercel",
    capability: "deploy",
    tool: "create_vercel_deployment",
    summary: "deploy acme-crm-prod",
    resourceLabel: "acme-crm-prod",
    ...overrides,
  };
}

const localPreview: PolicyDecision = {
  effect: "approval_required",
  reason: "Production deploys require approval by default.",
  source: "default",
};

describe("DashClaw guard payload mapping", () => {
  it("marks risky capabilities", () => {
    expect(isRiskyAction(actionContext({ capability: "read" }))).toBe(false);
    expect(isRiskyAction(actionContext({ capability: "write" }))).toBe(true);
    expect(isRiskyAction(actionContext({ capability: "deploy" }))).toBe(true);
    expect(isRiskyAction(actionContext({ capability: "env_change" }))).toBe(true);
    expect(isRiskyAction(actionContext({ capability: "delete" }))).toBe(true);
    expect(isRiskyAction(actionContext({ capability: "destructive_sql" }))).toBe(true);
    expect(isRiskyAction(actionContext({ capability: "read", live: true }))).toBe(true);
  });

  it("builds provider deploy guard payload", () => {
    const payload = buildDashclawGuardPayload(actionContext(), localPreview, "audit_123");

    expect(payload).toMatchObject({
      action_type: "provider_deploy",
      declared_goal: "deploy acme-crm-prod",
      reversible: false,
      risk_score: 85,
      systems_touched: ["vercel:acme-crm-prod", "project:acme-crm", "environment:production"],
      metadata: {
        provider: "vercel",
        capability: "deploy",
        tool: "create_vercel_deployment",
        local_policy_effect: "approval_required",
        audit_correlation_id: "audit_123",
      },
    });
  });

  it("does not include secret-looking metadata", () => {
    const payload = buildDashclawGuardPayload(
      actionContext({ summary: "set env DATABASE_URL on prod", resourceLabel: "project:DATABASE_URL" }),
      localPreview,
      "audit_123",
    );

    expect(JSON.stringify(payload)).not.toContain("postgres://");
    expect(JSON.stringify(payload)).not.toContain("sk_live");
    expect(JSON.stringify(payload)).not.toContain("TOKEN=");
  });

  it("fingerprints SQL without exposing raw SQL", () => {
    const sql = "DELETE FROM customers WHERE email = 'a@example.com'";
    const fp = sqlFingerprint(sql);

    expect(fp).toBe(createHash("sha256").update(sql).digest("hex").slice(0, 16));
    expect(fp).not.toContain("customers");
    expect(fp).not.toContain("example.com");
  });
});
```

- [x] **Step 2: Run tests and verify mapping failures**

Run:

```powershell
npm test -- test/dashclaw.test.ts
```

Expected: fail because `buildDashclawGuardPayload`, `isRiskyAction`, and `sqlFingerprint` are not implemented.

- [x] **Step 3: Implement payload mapping**

Replace `src/dashclaw/guard.ts` with:

```ts
import { createHash } from "node:crypto";
import { evaluatePolicy } from "../policy.js";
import type { Store } from "../storage.js";
import type { ActionContext, Capability, PolicyDecision } from "../types.js";
import { newId, OfflocalError } from "../util.js";
import { dashclawFetch } from "./client.js";
import type { DashclawDecision, DashclawGuardDecision, DashclawGuardPayload } from "./types.js";

export function normalizeDashclawDecision(value: unknown): DashclawDecision {
  if (value === "allow") return "allow";
  if (value === "block") return "block";
  if (value === "require_approval" || value === "approval_required") return "require_approval";
  throw new OfflocalError(`Unknown DashClaw decision "${String(value)}".`);
}

export function isRiskyAction(ctx: ActionContext): boolean {
  return ctx.live === true || ctx.capability !== "read";
}

export function sqlFingerprint(sql: string): string {
  return createHash("sha256").update(sql).digest("hex").slice(0, 16);
}

function actionType(ctx: ActionContext): string {
  if (ctx.provider === "stripe" && ctx.live && ctx.capability === "write") return "stripe_live_write";
  if (ctx.provider === "supabase" && ctx.capability === "destructive_sql") return "database_destructive_sql";
  if (ctx.provider === "supabase" && ctx.capability === "write") return "database_write";
  if (ctx.capability === "deploy") return "provider_deploy";
  if (ctx.capability === "env_change") return "provider_env_change";
  if (ctx.capability === "delete") return "provider_delete";
  if (ctx.capability === "write") return "provider_write";
  return "provider_read";
}

function riskScore(ctx: ActionContext): number {
  if (ctx.capability === "destructive_sql" || ctx.capability === "delete") return 95;
  if (ctx.live === true) return 90;
  if (ctx.capability === "deploy" && ctx.environment.isProduction) return 85;
  if (ctx.capability === "env_change" && ctx.environment.isProduction) return 85;
  if (ctx.capability === "write" && ctx.environment.isProduction) return 80;
  if (ctx.capability === "deploy" || ctx.capability === "env_change") return 65;
  if (ctx.capability === "write") return 60;
  return 20;
}

function reversible(ctx: ActionContext): boolean {
  if (ctx.capability === "destructive_sql" || ctx.capability === "delete") return false;
  if (ctx.live === true) return false;
  if (ctx.environment.isProduction && (ctx.capability === "deploy" || ctx.capability === "env_change")) return false;
  return true;
}

function systemsTouched(ctx: ActionContext): string[] {
  const resource = ctx.resourceLabel ? `${ctx.provider}:${ctx.resourceLabel}` : ctx.provider;
  return [resource, `project:${ctx.project.slug}`, `environment:${ctx.environment.name}`];
}

export function buildDashclawGuardPayload(
  ctx: ActionContext,
  localPreview: PolicyDecision,
  auditCorrelationId: string,
): DashclawGuardPayload {
  return {
    action_type: actionType(ctx),
    declared_goal: ctx.summary,
    systems_touched: systemsTouched(ctx),
    reversible: reversible(ctx),
    risk_score: riskScore(ctx),
    metadata: {
      offlocal_project_id: ctx.project.id,
      offlocal_project_slug: ctx.project.slug,
      offlocal_project_name: ctx.project.name,
      environment_id: ctx.environment.id,
      environment_name: ctx.environment.name,
      environment_kind: ctx.environment.kind,
      environment_is_production: ctx.environment.isProduction,
      provider: ctx.provider,
      capability: ctx.capability,
      tool: ctx.tool,
      resource_label: ctx.resourceLabel,
      local_policy_effect: localPreview.effect,
      local_policy_reason: localPreview.reason,
      local_policy_source: localPreview.source,
      live: ctx.live === true,
      audit_correlation_id: auditCorrelationId,
    },
  };
}

export function localPolicyPreview(store: Store, ctx: ActionContext): PolicyDecision {
  return evaluatePolicy(store.data.policyRules, ctx);
}

export async function guardWithDashclaw(
  store: Store,
  ctx: ActionContext,
  auditCorrelationId = newId("audit"),
): Promise<DashclawGuardDecision> {
  const payload = buildDashclawGuardPayload(ctx, localPolicyPreview(store, ctx), auditCorrelationId);
  const raw = await dashclawFetch<Record<string, any>>("/api/guard", { method: "POST", body: payload });
  const decision = normalizeDashclawDecision(raw.decision ?? raw.status ?? raw.result?.decision);
  return {
    decision,
    reason: String(raw.reason ?? raw.reasons?.[0] ?? `DashClaw decision: ${decision}`),
    decisionId: typeof raw.decision_id === "string" ? raw.decision_id : typeof raw.decisionId === "string" ? raw.decisionId : undefined,
    actionId: typeof raw.action_id === "string" ? raw.action_id : typeof raw.actionId === "string" ? raw.actionId : undefined,
    verificationStatus:
      typeof raw.verification_status === "string" ? raw.verification_status : typeof raw.verificationStatus === "string" ? raw.verificationStatus : undefined,
    signals: raw.signals,
    raw,
  };
}
```

- [x] **Step 4: Remove unused imports and run focused tests**

Run:

```powershell
npm test -- test/dashclaw.test.ts
npm run typecheck
```

Expected: pass. If TypeScript flags an unused `Capability` import, remove it from `src/dashclaw/guard.ts`.

- [x] **Step 5: Commit**

```powershell
git add src/dashclaw/guard.ts test/dashclaw.test.ts
git commit -m "feat: map offlocal actions to dashclaw guard payloads"
```

---

### Task 3: Local Audit Metadata for DashClaw Correlation

**Files:**
- Modify: `src/types.ts`
- Modify: `src/service.ts`
- Modify: `test/operations.test.ts`

- [x] **Step 1: Add failing audit export test**

Append this assertion to the existing `exports audit entries as jsonl, csv, and markdown` test in `test/operations.test.ts` after the current `store.appendAudit(...)` call:

```ts
    store.appendAudit({
      timestamp: "2026-06-09T00:00:01.000Z",
      projectSlug: "acme-crm",
      environment: "production",
      provider: "vercel",
      tool: "create_vercel_deployment",
      actionSummary: "deploy production",
      policyDecision: "approval_required",
      result: "not_executed",
      providerResource: "acme-prod",
      dashclawDecisionId: "gd_123",
      dashclawActionId: "act_123",
      dashclawOutcomeRecorded: false,
    });

    expect(exportAuditLog(store, { project: "acme-crm", format: "csv" })).toContain("dashclawDecisionId");
    expect(exportAuditLog(store, { project: "acme-crm", format: "csv" })).toContain("gd_123");
    expect(exportAuditLog(store, { project: "acme-crm", format: "markdown" })).toContain("act_123");
```

- [x] **Step 2: Run test and verify type/export failure**

Run:

```powershell
npm test -- test/operations.test.ts
npm run typecheck
```

Expected: fail because `AuditLogEntry` does not include DashClaw fields and export rows do not include them.

- [x] **Step 3: Extend `AuditLogEntry`**

In `src/types.ts`, add these optional fields to `AuditLogEntry`:

```ts
  /** DashClaw guard decision id, when DashClaw governed this action. */
  dashclawDecisionId?: string;
  /** DashClaw action id, when DashClaw returned or created one. */
  dashclawActionId?: string;
  /** Whether offlocal recorded the post-execution outcome to DashClaw. */
  dashclawOutcomeRecorded?: boolean;
  /** DashClaw guard/evidence error when governance metadata could not be recorded. */
  dashclawError?: string;
  /** Local correlation id used to connect guard payload, audit line, and outcome. */
  auditCorrelationId?: string;
```

- [x] **Step 4: Include DashClaw fields in audit export**

In `src/service.ts`, replace `auditExportRows()` with:

```ts
function auditExportRows(entries: AuditLogEntry[]): string[][] {
  return entries.map((entry) => [
    entry.timestamp,
    entry.projectSlug ?? "",
    entry.environment ?? "",
    entry.provider ?? "",
    entry.tool,
    entry.policyDecision,
    entry.result,
    entry.providerResource ?? "",
    entry.errorMessage ?? "",
    entry.dashclawDecisionId ?? "",
    entry.dashclawActionId ?? "",
    entry.dashclawOutcomeRecorded === undefined ? "" : String(entry.dashclawOutcomeRecorded),
    entry.dashclawError ?? "",
    entry.auditCorrelationId ?? "",
  ]);
}
```

Replace the `headers` constant in `exportAuditLog()` with:

```ts
  const headers = [
    "timestamp",
    "project",
    "environment",
    "provider",
    "tool",
    "policyDecision",
    "result",
    "providerResource",
    "errorMessage",
    "dashclawDecisionId",
    "dashclawActionId",
    "dashclawOutcomeRecorded",
    "dashclawError",
    "auditCorrelationId",
  ];
```

Replace `titleHeaders` in the markdown branch with:

```ts
    const titleHeaders = [
      "Timestamp",
      "Project",
      "Environment",
      "Provider",
      "Tool",
      "Policy",
      "Result",
      "Resource",
      "Error",
      "DashClaw Decision",
      "DashClaw Action",
      "DashClaw Outcome",
      "DashClaw Error",
      "Correlation",
    ];
```

- [x] **Step 5: Run tests and commit**

Run:

```powershell
npm test -- test/operations.test.ts
npm run typecheck
```

Expected: pass.

Commit:

```powershell
git add src/types.ts src/service.ts test/operations.test.ts
git commit -m "feat: include dashclaw metadata in audit exports"
```

---

### Task 4: Authoritative DashClaw Gate Inside `runGuarded()`

**Files:**
- Modify: `src/actions.ts`
- Modify: `src/dashclaw/types.ts`
- Create: `src/dashclaw/evidence.ts`
- Modify: `test/actions.test.ts`

- [x] **Step 1: Add failing `runGuarded()` DashClaw tests**

Append to `test/actions.test.ts`:

```ts
describe("runGuarded DashClaw authoritative mode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DASHCLAW_BASE_URL;
    delete process.env.DASHCLAW_API_KEY;
  });

  function enableDashclaw(decision: Record<string, unknown>) {
    process.env.DASHCLAW_BASE_URL = "https://dashclaw.example";
    process.env.DASHCLAW_API_KEY = "dc_key";
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/guard")) {
        return new Response(JSON.stringify(decision), { status: 200 });
      }
      if (url.includes("/api/actions/") && url.endsWith("/outcome")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "unexpected route", url, body: init?.body }), { status: 404 });
    }));
  }

  function productionDeployContext() {
    const store = freshStore();
    seedAcme(store);
    const project = resolveProject(store, "acme-crm");
    const environment = resolveEnvironment(store, project, "production");
    return {
      store,
      ctx: {
        project,
        environment,
        provider: "vercel" as const,
        capability: "deploy" as const,
        tool: "create_vercel_deployment",
        summary: "deploy acme production",
        resourceLabel: "acme-prod",
      },
    };
  }

  it("allows risky action only after DashClaw allow", async () => {
    enableDashclaw({ decision: "allow", reason: "approved by policy", decision_id: "gd_1", action_id: "act_1" });
    const { store, ctx } = productionDeployContext();
    const exec = vi.fn(async () => ({ deploymentId: "dpl_1" }));

    const res = await runGuarded(store, ctx, exec);

    expect(res.status).toBe("ok");
    expect(exec).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("https://dashclaw.example/api/guard", expect.any(Object));
    expect(fetch).toHaveBeenCalledWith("https://dashclaw.example/api/actions/act_1/outcome", expect.any(Object));
    expect(store.readAudit()).toHaveLength(1);
    expect(store.readAudit()[0]).toMatchObject({
      result: "success",
      dashclawDecisionId: "gd_1",
      dashclawActionId: "act_1",
      dashclawOutcomeRecorded: true,
    });
  });

  it("blocks risky action when DashClaw blocks", async () => {
    enableDashclaw({ decision: "block", reason: "deployment window closed", decision_id: "gd_2", action_id: "act_2" });
    const { store, ctx } = productionDeployContext();
    const exec = vi.fn(async () => ({ deploymentId: "dpl_1" }));

    const res = await runGuarded(store, ctx, exec);

    expect(res.status).toBe("blocked");
    expect(exec).not.toHaveBeenCalled();
    expect(store.readAudit()[0]).toMatchObject({
      result: "not_executed",
      policyDecision: "block",
      dashclawDecisionId: "gd_2",
      dashclawActionId: "act_2",
    });
  });

  it("returns approval required when DashClaw requires approval without creating local approval", async () => {
    enableDashclaw({ decision: "require_approval", reason: "human review", decision_id: "gd_3", action_id: "act_3" });
    const { store, ctx } = productionDeployContext();
    const exec = vi.fn(async () => ({ deploymentId: "dpl_1" }));

    const res = await runGuarded(store, ctx, exec);

    expect(res.status).toBe("approval_required");
    expect(exec).not.toHaveBeenCalled();
    expect(store.data.pendingApprovals).toHaveLength(0);
    expect((res as any).dashclaw).toMatchObject({ decision_id: "gd_3", action_id: "act_3" });
  });

  it("fails closed for risky actions when DashClaw env is missing", async () => {
    const { store, ctx } = productionDeployContext();
    const exec = vi.fn(async () => ({ deploymentId: "dpl_1" }));

    const res = await runGuarded(store, ctx, exec);

    expect(res.status).toBe("error");
    expect(res.executed).toBe(false);
    expect(exec).not.toHaveBeenCalled();
    expect(store.readAudit()[0]).toMatchObject({
      result: "not_executed",
      dashclawError: expect.stringMatching(/DASHCLAW_BASE_URL/i),
    });
  });

  it("allows reads to proceed when DashClaw env is missing", async () => {
    const { store, project, environment } = stagingContext();
    const exec = vi.fn(async () => ({ ok: true }));

    const res = await runGuarded(
      store,
      { project, environment, provider: "github", capability: "read", tool: "read_repo", summary: "read repo" },
      exec,
    );

    expect(res.status).toBe("ok");
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
```

Also update the first import in `test/actions.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
```

- [x] **Step 2: Run tests and verify failures**

Run:

```powershell
npm test -- test/actions.test.ts
```

Expected: fail because `runGuarded()` does not call DashClaw and response types do not include `dashclaw`.

- [x] **Step 3: Extend response types with DashClaw metadata**

In `src/actions.ts`, add this interface near response interfaces:

```ts
export interface DashclawResponseMetadata {
  decision?: "allow" | "block" | "require_approval";
  decision_id?: string;
  action_id?: string;
  verification_status?: string;
  outcome_recorded?: boolean;
  error?: string;
}
```

Add `dashclaw?: DashclawResponseMetadata;` to `ApprovalRequiredResponse`, `BlockedResponse`, `OkResponse`, `ErrorResponse`, and `PreExecutionErrorResponse`.

- [x] **Step 4: Add outcome recording helper**

Create `src/dashclaw/evidence.ts`:

```ts
import { dashclawFetch } from "./client.js";
import type { DashclawOutcomeInput } from "./types.js";

export async function recordDashclawOutcome(input: DashclawOutcomeInput): Promise<boolean> {
  await dashclawFetch(`/api/actions/${encodeURIComponent(input.actionId)}/outcome`, {
    method: "POST",
    body: {
      status: input.status,
      duration_ms: input.durationMs,
      summary: input.summary,
      metadata: input.metadata,
      error_message: input.errorMessage,
    },
  });
  return true;
}
```

- [x] **Step 5: Refactor `runGuarded()` to guard risky actions before execution**

In `src/actions.ts`, add imports:

```ts
import { guardWithDashclaw, isRiskyAction } from "./dashclaw/guard.js";
import { recordDashclawOutcome } from "./dashclaw/evidence.js";
import type { DashclawGuardDecision } from "./dashclaw/types.js";
```

Inside `runGuarded()` after `mode`, add:

```ts
  const risky = isRiskyAction(ctx);
```

Inside the `withAuditLock` callback, before local policy block handling, add:

```ts
      let dashclawDecision: DashclawGuardDecision | undefined;
      const dashclawMeta = (): DashclawResponseMetadata | undefined =>
        dashclawDecision
          ? {
              decision: dashclawDecision.decision,
              decision_id: dashclawDecision.decisionId,
              action_id: dashclawDecision.actionId,
              verification_status: dashclawDecision.verificationStatus,
            }
          : undefined;

      async function recordOutcome(
        status: "success" | "error" | "not_executed",
        startedAt: number,
        errorMessage?: string,
      ): Promise<boolean> {
        if (!dashclawDecision?.actionId) return false;
        return recordDashclawOutcome({
          actionId: dashclawDecision.actionId,
          status,
          durationMs: Date.now() - startedAt,
          summary: ctx.summary,
          errorMessage,
          metadata: {
            provider: ctx.provider,
            capability: ctx.capability,
            tool: ctx.tool,
            project: ctx.project.slug,
            environment: ctx.environment.name,
            resource_label: ctx.resourceLabel,
          },
        });
      }

      if (risky) {
        try {
          dashclawDecision = await guardWithDashclaw(store, ctx);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          appendAudit({
            timestamp: new Date().toISOString(),
            projectSlug: ctx.project.slug,
            environment: ctx.environment.name,
            provider: ctx.provider,
            tool: ctx.tool,
            actionSummary: ctx.summary,
            policyDecision: decision.effect,
            result: "not_executed",
            errorMessage: `DashClaw unavailable; refusing risky action. ${message}`,
            providerResource: ctx.resourceLabel,
            dashclawError: message,
          });
          return {
            ...base,
            status: "error",
            policy_decision: decision.effect,
            executed: false,
            error: `DashClaw unavailable; refusing risky action. ${message}`,
            dashclaw: { error: message },
          };
        }

        if (dashclawDecision.decision === "block") {
          auditWithDecision("not_executed", "block");
          return {
            ...base,
            status: "blocked",
            policy_decision: "block",
            executed: false,
            reason: dashclawDecision.reason,
            suggested_next_step: "DashClaw blocked this action. Review DashClaw guard decisions before retrying.",
            dashclaw: dashclawMeta(),
          };
        }

        if (dashclawDecision.decision === "require_approval") {
          auditWithDecision("not_executed", "approval_required");
          return {
            ...base,
            status: "approval_required",
            policy_decision: "approval_required",
            executed: false,
            approval_id: dashclawDecision.actionId ?? dashclawDecision.decisionId ?? "dashclaw",
            reason: dashclawDecision.reason,
            suggested_next_step: "DashClaw requires approval. Use DashClaw approval tooling, then rerun the original action.",
            dashclaw: dashclawMeta(),
          };
        }
      }
```

Then replace `auditWithDecision()` body with:

```ts
        appendAudit({
          timestamp: new Date().toISOString(),
          projectSlug: ctx.project.slug,
          environment: ctx.environment.name,
          provider: ctx.provider,
          tool: ctx.tool,
          actionSummary: ctx.summary,
          policyDecision,
          result,
          errorMessage,
          providerResource: ctx.resourceLabel,
          dashclawDecisionId: dashclawDecision?.decisionId,
          dashclawActionId: dashclawDecision?.actionId,
          dashclawOutcomeRecorded:
            dashclawDecision?.actionId === undefined ? undefined : result === "success" || result === "error" ? undefined : false,
        });
```

Replace `executeAllowed()` with:

```ts
      async function executeAllowed(reason: string): Promise<OkResponse | ErrorResponse> {
        const startedAt = Date.now();
        try {
          const data = await exec();
          let outcomeRecorded: boolean | undefined;
          let outcomeError: string | undefined;
          try {
            outcomeRecorded = await recordOutcome("success", startedAt);
          } catch (err) {
            outcomeRecorded = false;
            outcomeError = err instanceof Error ? err.message : String(err);
          }
          auditWithDecision("success", "allow");
          return {
            ...base,
            status: "ok",
            policy_decision: "allow",
            executed: true,
            mode,
            reason,
            data,
            dashclaw: dashclawDecision
              ? { ...dashclawMeta(), outcome_recorded: outcomeRecorded, error: outcomeError }
              : undefined,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          let outcomeRecorded: boolean | undefined;
          let outcomeError: string | undefined;
          try {
            outcomeRecorded = await recordOutcome("error", startedAt, message);
          } catch (outcomeErr) {
            outcomeRecorded = false;
            outcomeError = outcomeErr instanceof Error ? outcomeErr.message : String(outcomeErr);
          }
          auditWithDecision("error", "allow", message);
          return {
            ...base,
            status: "error",
            policy_decision: "allow",
            executed: true,
            error: message,
            dashclaw: dashclawDecision
              ? { ...dashclawMeta(), outcome_recorded: outcomeRecorded, error: outcomeError }
              : undefined,
          };
        }
      }
```

After focused tests pass, improve `auditWithDecision()` so `dashclawOutcomeRecorded` receives the same `outcomeRecorded` value recorded in responses. Use a fourth optional parameter:

```ts
function auditWithDecision(
  result: AuditResult,
  policyDecision: PolicyEffect,
  errorMessage?: string,
  dashclawOutcomeRecorded?: boolean,
): void
```

Pass `outcomeRecorded` from success/error execution calls.

- [x] **Step 6: Run focused tests**

Run:

```powershell
npm test -- test/actions.test.ts test/providers.test.ts
npm run typecheck
```

Expected: pass. Existing provider tests should still pass because they use risky actions; update test setup to provide DashClaw env and guard mocks only where the action is expected to execute. For tests that assert gated local policy behavior, keep DashClaw disabled and adjust expectations to fail-closed only for risky actions if local policy no longer runs first.

- [x] **Step 7: Commit**

```powershell
git add src/actions.ts src/dashclaw/evidence.ts src/dashclaw/types.ts test/actions.test.ts test/providers.test.ts
git commit -m "feat: enforce dashclaw gate for risky actions"
```

---

### Task 5: DashClaw Operational Service APIs

**Files:**
- Modify: `src/dashclaw/evidence.ts`
- Modify: `src/service.ts`
- Modify: `test/operations.test.ts`

- [x] **Step 1: Add failing service tests**

Append to `test/operations.test.ts`:

```ts
import {
  dashclawRecentDecisions,
  dashclawStatus,
  explainActionRisk,
  exportDashclawEvidence,
  governedActionSummary,
} from "../src/service.js";

describe("DashClaw operations", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DASHCLAW_BASE_URL;
    delete process.env.DASHCLAW_API_KEY;
  });

  it("reports DashClaw status", async () => {
    process.env.DASHCLAW_BASE_URL = "https://dashclaw.example";
    process.env.DASHCLAW_API_KEY = "dc_key";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));

    const report = await dashclawStatus();

    expect(report).toMatchObject({ configured: true, reachable: true, mode: "authoritative" });
  });

  it("exports local evidence linked to DashClaw ids", () => {
    const store = freshStore();
    seedAcme(store);
    store.appendAudit({
      timestamp: "2026-06-09T00:00:00.000Z",
      projectSlug: "acme-crm",
      environment: "production",
      provider: "vercel",
      tool: "create_vercel_deployment",
      actionSummary: "deploy prod",
      policyDecision: "approval_required",
      result: "not_executed",
      dashclawDecisionId: "gd_1",
      dashclawActionId: "act_1",
    });

    const evidence = exportDashclawEvidence(store, { project: "acme-crm", environment: "production" });

    expect(evidence).toMatchObject({
      schema: "offlocal.dashclaw.evidence.v1",
      entries: [expect.objectContaining({ dashclawDecisionId: "gd_1", dashclawActionId: "act_1" })],
    });
  });

  it("explains action risk without executing a provider call", async () => {
    const store = freshStore();
    seedAcme(store);
    process.env.DASHCLAW_BASE_URL = "https://dashclaw.example";
    process.env.DASHCLAW_API_KEY = "dc_key";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ decision: "require_approval", reason: "review" }), { status: 200 })));

    const explanation = await explainActionRisk(store, {
      project: "acme-crm",
      environment: "production",
      provider: "vercel",
      capability: "deploy",
      tool: "create_vercel_deployment",
      summary: "deploy prod",
      resourceLabel: "acme-prod",
    });

    expect(explanation).toMatchObject({
      risky: true,
      localPolicy: expect.objectContaining({ effect: "approval_required" }),
      dashclaw: expect.objectContaining({ decision: "require_approval" }),
    });
  });
});
```

Update the top import in `test/operations.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
```

- [x] **Step 2: Run test and verify failures**

Run:

```powershell
npm test -- test/operations.test.ts
```

Expected: fail because service functions are missing.

- [x] **Step 3: Add evidence helpers**

Extend `src/dashclaw/evidence.ts`:

```ts
import { dashclawConfigFromEnv, dashclawFetch } from "./client.js";
import type { DashclawStatusReport } from "./types.js";

export async function dashclawStatusReport(): Promise<DashclawStatusReport> {
  let config;
  try {
    config = dashclawConfigFromEnv();
  } catch (err) {
    return { configured: false, mode: "authoritative", reachable: false, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    await dashclawFetch("/api/doctor");
    return { configured: true, baseUrl: config.baseUrl, mode: config.mode, reachable: true };
  } catch (err) {
    return {
      configured: true,
      baseUrl: config.baseUrl,
      mode: config.mode,
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function dashclawRecentDecisionsFetch(query: { project?: string; environment?: string; limit?: number }) {
  return dashclawFetch("/api/guard/decisions", {
    query: {
      project: query.project,
      environment: query.environment,
      limit: query.limit === undefined ? undefined : String(query.limit),
    },
  });
}
```

- [x] **Step 4: Add service APIs**

In `src/service.ts`, import:

```ts
import { dashclawRecentDecisionsFetch, dashclawStatusReport } from "./dashclaw/evidence.js";
import { buildDashclawGuardPayload, guardWithDashclaw, isRiskyAction, localPolicyPreview } from "./dashclaw/guard.js";
```

Add service functions near operational readiness functions:

```ts
export function dashclawStatus() {
  return dashclawStatusReport();
}

export function exportDashclawEvidence(
  store: Store,
  input: { project?: string; environment?: string; provider?: ProviderId; limit?: number } = {},
) {
  const entries = listAuditLog(store, input).filter((entry) => entry.dashclawDecisionId || entry.dashclawActionId || entry.dashclawError);
  return {
    schema: "offlocal.dashclaw.evidence.v1",
    exportedAt: nowIso(),
    entries,
  };
}

export async function dashclawRecentDecisions(
  store: Store,
  input: { project?: string; environment?: string; limit?: number } = {},
) {
  assertPositiveInteger(input.limit, "limit");
  const project = input.project ? resolveProject(store, input.project).slug : undefined;
  return dashclawRecentDecisionsFetch({ project, environment: input.environment, limit: input.limit ?? 20 });
}

export async function explainActionRisk(
  store: Store,
  input: {
    project?: string;
    environment: string;
    provider: ProviderId;
    capability: Capability;
    tool: string;
    summary: string;
    resourceLabel?: string;
    live?: boolean;
  },
) {
  const project = resolveProject(store, input.project);
  const environment = resolveEnvironment(store, project, input.environment);
  const ctx: ActionContext = {
    project,
    environment,
    provider: input.provider,
    capability: input.capability,
    tool: input.tool,
    summary: input.summary,
    resourceLabel: input.resourceLabel,
    live: input.live,
  };
  const localPolicy = localPolicyPreview(store, ctx);
  const payload = buildDashclawGuardPayload(ctx, localPolicy, newId("audit"));
  let dashclaw: unknown;
  try {
    dashclaw = await guardWithDashclaw(store, ctx);
  } catch (err) {
    dashclaw = { error: err instanceof Error ? err.message : String(err) };
  }
  return { risky: isRiskyAction(ctx), localPolicy, dashclawPayload: payload, dashclaw };
}

export function governedActionSummary(
  store: Store,
  input: { project?: string; environment?: string; provider?: ProviderId; limit?: number } = {},
) {
  const entries = listAuditLog(store, input);
  return {
    project: input.project,
    environment: input.environment,
    provider: input.provider,
    entries: entries.map((entry) => ({
      timestamp: entry.timestamp,
      tool: entry.tool,
      result: entry.result,
      policyDecision: entry.policyDecision,
      dashclawDecisionId: entry.dashclawDecisionId,
      dashclawActionId: entry.dashclawActionId,
      dashclawOutcomeRecorded: entry.dashclawOutcomeRecorded,
      dashclawError: entry.dashclawError,
    })),
  };
}
```

- [x] **Step 5: Run focused tests and commit**

Run:

```powershell
npm test -- test/operations.test.ts
npm run typecheck
```

Expected: pass.

Commit:

```powershell
git add src/dashclaw/evidence.ts src/service.ts test/operations.test.ts
git commit -m "feat: add dashclaw operational services"
```

---

### Task 6: MCP and CLI Product Surface

**Files:**
- Modify: `src/tools/index.ts`
- Modify: `src/cli.ts`
- Modify: `test/tools.test.ts`
- Modify: `test/cli.test.ts`

- [x] **Step 1: Add failing MCP schema tests**

In `test/tools.test.ts`, add expectations to the operational readiness tool test:

```ts
    expect(tools.has("dashclaw_status")).toBe(true);
    expect(tools.has("dashclaw_recent_decisions")).toBe(true);
    expect(tools.has("export_dashclaw_evidence")).toBe(true);
    expect(tools.has("explain_action_risk")).toBe(true);
    expect(tools.has("governed_action_summary")).toBe(true);
    expect(inputSchema("dashclaw_recent_decisions").limit.safeParse(0).success).toBe(false);
    expect(inputSchema("explain_action_risk").capability.safeParse("deploy").success).toBe(true);
```

- [x] **Step 2: Add failing CLI tests**

Append to `test/cli.test.ts`:

```ts
  it("prints DashClaw status from the CLI", () => {
    const res = runCli(["dashclaw", "status"]);

    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({
      status: "ok",
      dashclaw: expect.objectContaining({ configured: false, reachable: false }),
    });
  });

  it("exports DashClaw evidence from the CLI", () => {
    const offlocalHome = createMappedProjectHome();
    writeFileSync(
      join(offlocalHome, "audit.log"),
      JSON.stringify({
        timestamp: "2026-06-09T00:00:00.000Z",
        projectSlug: "acme-crm",
        environment: "staging",
        provider: "vercel",
        tool: "create_vercel_deployment",
        actionSummary: "deploy",
        policyDecision: "approval_required",
        result: "not_executed",
        dashclawDecisionId: "gd_1",
      }) + "\n",
    );

    const res = runCli(["dashclaw", "evidence", "--project", "acme-crm"], offlocalHome);

    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({
      schema: "offlocal.dashclaw.evidence.v1",
      entries: [expect.objectContaining({ dashclawDecisionId: "gd_1" })],
    });
  });
```

- [x] **Step 3: Run tests and verify failures**

Run:

```powershell
npm test -- test/tools.test.ts test/cli.test.ts
```

Expected: fail because MCP tools and CLI subcommands are missing.

- [x] **Step 4: Register MCP tools**

In `src/tools/index.ts`, register these before `registerProviderTools(server, store);`:

```ts
  server.registerTool(
    "dashclaw_status",
    {
      title: "DashClaw status",
      description: "Check DashClaw authoritative gate configuration and reachability.",
      inputSchema: {},
    },
    guard(async () => ({ status: "ok", dashclaw: await svc.dashclawStatus() })),
  );

  server.registerTool(
    "dashclaw_recent_decisions",
    {
      title: "DashClaw recent decisions",
      description: "Read recent DashClaw guard decisions scoped to project/environment when supported by DashClaw.",
      inputSchema: {
        project: optionalNonEmptyString(),
        environment: optionalNonEmptyString(),
        limit: positiveInt().optional(),
      },
    },
    guard((a: { project?: string; environment?: string; limit?: number }) => svc.dashclawRecentDecisions(store, a)),
  );

  server.registerTool(
    "export_dashclaw_evidence",
    {
      title: "Export DashClaw evidence",
      description: "Export local audit entries that include DashClaw guard/evidence metadata.",
      inputSchema: {
        project: optionalNonEmptyString(),
        environment: optionalNonEmptyString(),
        provider: provider.optional(),
        limit: positiveInt().optional(),
      },
    },
    guard((a: { project?: string; environment?: string; provider?: (typeof PROVIDER_IDS)[number]; limit?: number }) => ({
      status: "ok",
      evidence: svc.exportDashclawEvidence(store, a),
    })),
  );

  server.registerTool(
    "explain_action_risk",
    {
      title: "Explain action risk",
      description: "Dry-run local policy and DashClaw guard context for a provider action without executing it.",
      inputSchema: {
        project: optionalNonEmptyString(),
        environment: nonEmptyString(),
        provider,
        capability,
        tool: nonEmptyString(),
        summary: nonEmptyString(),
        resourceLabel: optionalNonEmptyString(),
        live: z.boolean().optional(),
      },
    },
    guard((a: any) => svc.explainActionRisk(store, a)),
  );

  server.registerTool(
    "governed_action_summary",
    {
      title: "Governed action summary",
      description: "Summarize recent local audit entries with DashClaw correlation fields.",
      inputSchema: {
        project: optionalNonEmptyString(),
        environment: optionalNonEmptyString(),
        provider: provider.optional(),
        limit: positiveInt().optional(),
      },
    },
    guard((a: { project?: string; environment?: string; provider?: (typeof PROVIDER_IDS)[number]; limit?: number }) => ({
      status: "ok",
      summary: svc.governedActionSummary(store, a),
    })),
  );
```

- [x] **Step 5: Add CLI commands**

In `src/cli.ts`, import:

```ts
  dashclawStatus,
  exportDashclawEvidence,
```

Add to `HELP`:

```text
  offlocal dashclaw status
  offlocal dashclaw evidence [--project <p>] [--env <e>] [--provider <p>] [--limit <n>]
```

Add a switch case before `context`:

```ts
    case "dashclaw": {
      const store = new Store();
      if (sub === "status") {
        print({ status: "ok", dashclaw: await dashclawStatus() });
      } else if (sub === "evidence") {
        print(
          exportDashclawEvidence(store, {
            project: flags.project,
            environment: flags.env,
            provider: flags.provider as ProviderId | undefined,
            limit: optionalPositiveInt(flags.limit, "--limit"),
          }),
        );
      } else {
        failCli("Unknown dashclaw subcommand. Try: status | evidence");
      }
      return;
    }
```

- [x] **Step 6: Run transport tests and commit**

Run:

```powershell
npm test -- test/tools.test.ts test/cli.test.ts
npm run typecheck
```

Expected: pass.

Commit:

```powershell
git add src/tools/index.ts src/cli.ts test/tools.test.ts test/cli.test.ts
git commit -m "feat: expose dashclaw governance tools"
```

---

### Task 7: Documentation and Environment Configuration

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `test/package.test.ts`

- [ ] **Step 1: Add failing docs smoke test**

In `test/package.test.ts`, extend the README smoke test:

```ts
    expect(readme).toContain("Governed Infrastructure Actions");
    expect(readme).toContain("DASHCLAW_BASE_URL");
    expect(readme).toContain("DASHCLAW_API_KEY");
    expect(readme).toContain("dashclaw_status");
```

- [ ] **Step 2: Run package test and verify failure**

Run:

```powershell
npm test -- test/package.test.ts
```

Expected: fail until README/env docs are updated.

- [ ] **Step 3: Update `.env.example`**

Add:

```text
# DashClaw authoritative governance gate for risky provider actions.
# Reads can proceed without DashClaw; writes/deploys/env changes/live/destructive actions fail closed.
DASHCLAW_BASE_URL=
DASHCLAW_API_KEY=
DASHCLAW_TIMEOUT_MS=30000
OFFLOCAL_DASHCLAW_MODE=authoritative
```

- [ ] **Step 4: Update README**

Add a section after the MCP tools list:

```markdown
## Governed Infrastructure Actions

offlocal can use DashClaw as the authoritative guard for risky provider actions.
In this mode, offlocal remains the provider execution layer and DashClaw becomes
the decision, approval, and evidence authority.

Risky actions are writes, deploys, env-var changes, deletes, destructive SQL, and
live-mode actions. These actions call DashClaw before execution. If DashClaw
allows the action, offlocal executes it and records the outcome. If DashClaw
blocks or requires approval, offlocal does not call the provider. If DashClaw is
unavailable, risky actions fail closed. Read actions continue through local
policy and audit.

Required env vars:

| Variable | Notes |
|---|---|
| `DASHCLAW_BASE_URL` | DashClaw base URL, e.g. `https://dashclaw.example.com` |
| `DASHCLAW_API_KEY` | Workspace API key sent as `x-api-key` |
| `DASHCLAW_TIMEOUT_MS` | Optional DashClaw timeout; defaults to `30000` |
| `OFFLOCAL_DASHCLAW_MODE` | `authoritative` in this version |

DashClaw tools:

- `dashclaw_status`
- `dashclaw_recent_decisions`
- `export_dashclaw_evidence`
- `explain_action_risk`
- `governed_action_summary`
```

Also add these tools to the existing MCP tool inventory under a new **DashClaw** line.

- [ ] **Step 5: Run docs tests and commit**

Run:

```powershell
npm test -- test/package.test.ts
```

Expected: pass.

Commit:

```powershell
git add .env.example README.md test/package.test.ts
git commit -m "docs: document dashclaw authoritative governance"
```

---

### Task 8: Full Verification and Regression Review

**Files:**
- Review all files changed by Tasks 1-7.

- [ ] **Step 1: Run full verification**

Run:

```powershell
npm run verify
```

Expected:

- typecheck passes
- build passes
- all Vitest tests pass
- `npm audit` reports zero vulnerabilities or only known advisories already accepted by the project owner

- [ ] **Step 2: Inspect risky-action audit behavior manually through tests**

Run:

```powershell
npm test -- test/actions.test.ts test/providers.test.ts test/operations.test.ts
```

Expected: pass. Confirm in the test names and assertions that:

- risky actions fail closed without DashClaw
- reads proceed without DashClaw
- DashClaw allow executes provider exactly once
- DashClaw block and approval do not execute provider
- outcome recording failure does not hide provider success

- [ ] **Step 3: Check for accidental secret exposure**

Run:

```powershell
rg -n "DASHCLAW_API_KEY|sk_live|sk_test|VERCEL_TOKEN|GITHUB_TOKEN|SUPABASE_ACCESS_TOKEN|RAILWAY_TOKEN" src test README.md .env.example
```

Expected: matches are only env var names, sample empty values, or tests asserting redaction. No real secret values appear.

- [ ] **Step 4: Check final worktree**

Run:

```powershell
git status --short
```

Expected: only intentional changes remain. Do not revert unrelated dirty files from previous work. If unrelated dirty files exist, mention them in the handoff.

- [ ] **Step 5: Final commit**

If Task 8 required fixes:

```powershell
git add <fixed-files>
git commit -m "test: verify dashclaw authoritative gate"
```

If Task 8 required no fixes, do not create an empty commit.

---

## Self-Review Checklist

- Spec coverage: Tasks 1-6 implement DashClaw client, guard payload, authoritative `runGuarded()` behavior, evidence recording, audit correlation, operational tools, and CLI/MCP exposure. Task 7 documents env/product surface. Task 8 verifies the complete repo.
- Completeness scan: every task includes exact files, code shapes, commands, expected failures, expected passes, and commit messages.
- Type consistency: plan uses `DashclawDecision`, `DashclawGuardDecision`, `DashclawGuardPayload`, `DashclawOutcomeInput`, and `DashclawStatusReport` consistently from `src/dashclaw/types.ts`.
- Scope control: provider follow-on connections such as GitHub Actions and Sentry are documented in the design spec, but not implemented in this plan.
