import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { freshStore, seedAcme } from "./helpers.js";
import * as pa from "../src/provider-actions.js";
import { listAuditLog } from "../src/service.js";
import type { Store } from "../src/storage.js";

/**
 * These tests exercise the guarded provider flow with a mocked global fetch, so
 * no real network calls happen. The key assertions are:
 *   - allowed actions EXECUTE (fetch is called) and audit "success";
 *   - approval_required / blocked actions DO NOT execute (fetch not called) and
 *     audit "not_executed".
 */

let fetchMock: ReturnType<typeof vi.fn>;

function mockOk(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock = vi.fn(async () => mockOk({ id: "obj_123", name: "Test", active: true, created: 1 }));
  vi.stubGlobal("fetch", fetchMock);
  process.env.STRIPE_TEST_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_LIVE_SECRET_KEY = "sk_live_dummy";
  process.env.VERCEL_TOKEN = "vc_dummy";
  process.env.SUPABASE_ACCESS_TOKEN = "sb_dummy";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function lastAudit(store: Store) {
  return listAuditLog(store, { project: "acme-crm" })[0];
}

describe("Stripe", () => {
  it("allows test-mode writes and executes them", async () => {
    const store = freshStore();
    seedAcme(store);
    const res = await pa.stripeCreateProduct(store, {
      environment: "staging", // staging -> stripe mode test
      name: "Pro Plan",
    });
    expect(res.status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastAudit(store)).toMatchObject({ result: "success", policyDecision: "allow", provider: "stripe" });
  });

  it("requires approval for live-mode writes and does NOT execute them", async () => {
    const store = freshStore();
    seedAcme(store);
    const res = await pa.stripeCreateProduct(store, {
      environment: "production", // production -> stripe mode live
      name: "Pro Plan",
    });
    expect(res.status).toBe("approval_required");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lastAudit(store)).toMatchObject({ result: "not_executed", policyDecision: "approval_required" });
  });
});

describe("Vercel", () => {
  it("requires approval for production deploys and does NOT execute them", async () => {
    const store = freshStore();
    seedAcme(store);
    const res = await pa.vercelCreateDeployment(store, { environment: "production" });
    expect(res.status).toBe("approval_required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires approval for production env-var changes", async () => {
    const store = freshStore();
    seedAcme(store);
    const res = await pa.vercelSetEnvVar(store, {
      environment: "production",
      key: "DATABASE_URL",
      value: "postgres://...",
    });
    expect(res.status).toBe("approval_required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows and executes a non-production (preview) deploy", async () => {
    const store = freshStore();
    seedAcme(store);
    const res = await pa.vercelCreateDeployment(store, { environment: "staging" });
    expect(res.status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("App logs", () => {
  /** Route a mocked fetch by URL to the right Vercel endpoint payload. */
  function routeVercel(opts: { deployments?: any[]; events?: any[]; status?: any }) {
    return (url: string) => {
      if (url.includes("/v7/deployments")) return mockOk({ deployments: opts.deployments ?? [] });
      if (/\/v3\/deployments\/[^/]+\/events/.test(url)) return mockOk(opts.events ?? []);
      if (url.includes("/v13/deployments/")) return mockOk(opts.status ?? {});
      return mockOk({});
    };
  }

  const LATEST = { uid: "dpl_123", url: "acme.vercel.app", readyState: "ERROR", state: "ERROR", created: 1700000000000 };

  it("get_vercel_logs resolves the latest deployment and returns normalized logs", async () => {
    const store = freshStore();
    seedAcme(store);
    fetchMock.mockImplementation(async (url: string) =>
      routeVercel({
        deployments: [LATEST],
        events: [
          { type: "stdout", created: 1700000001000, text: "Building..." },
          { type: "stderr", created: 1700000002000, text: "Error: DATABASE_URL is missing" },
        ],
      })(url),
    );

    const res = await pa.vercelLogs(store, { environment: "staging" });
    expect(res.status).toBe("ok");
    const data = (res as any).data;
    expect(data.resource.deployment_id).toBe("dpl_123");
    expect(data.resource.deployment_status).toBe("ERROR");
    expect(data.resource.deployment_url).toBe("https://acme.vercel.app");
    expect(data.logs).toHaveLength(2);
    expect(data.logs[1]).toMatchObject({ level: "error", message: "Error: DATABASE_URL is missing" });
    expect(data.audit_written).toBe(true);
    expect(lastAudit(store)).toMatchObject({ result: "success", policyDecision: "allow", provider: "vercel", tool: "get_vercel_logs" });
  });

  it("redacts secrets that appear in log lines", async () => {
    const store = freshStore();
    seedAcme(store);
    fetchMock.mockImplementation(async (url: string) =>
      routeVercel({
        deployments: [LATEST],
        events: [{ type: "stdout", created: 1700000001000, text: "Using key sk_live_ABCDEFGH123456789" }],
      })(url),
    );
    const res = await pa.vercelLogs(store, { environment: "staging" });
    const msg = (res as any).data.logs[0].message;
    expect(msg).not.toContain("sk_live_ABCDEFGH123456789");
    expect(msg).toContain("REDACTED");
  });

  it("returns a limitation (not an error) when the events API yields no logs", async () => {
    const store = freshStore();
    seedAcme(store);
    fetchMock.mockImplementation(async (url: string) => routeVercel({ deployments: [LATEST], events: [] })(url));
    const res = await pa.vercelLogs(store, { environment: "staging" });
    expect(res.status).toBe("ok");
    const data = (res as any).data;
    expect(data.logs).toHaveLength(0);
    expect(typeof data.limitation).toBe("string");
  });

  it("get_app_logs with no provider discovers the mapped Vercel project and audits the read", async () => {
    const store = freshStore();
    seedAcme(store);
    fetchMock.mockImplementation(async (url: string) =>
      routeVercel({ deployments: [LATEST], events: [{ type: "stdout", created: 1700000001000, text: "ok" }] })(url),
    );
    const res = await pa.appLogs(store, { environment: "staging" });
    expect(res.status).toBe("ok");
    expect(res.providers).toHaveLength(1);
    expect((res.providers[0] as any).provider).toBe("vercel");
    expect(lastAudit(store)).toMatchObject({ result: "success", provider: "vercel", tool: "get_app_logs" });
  });

  it("get_latest_deployment_logs returns a clear limitation for unsupported providers", async () => {
    const store = freshStore();
    seedAcme(store);
    const res = await pa.latestDeploymentLogs(store, { environment: "staging", provider: "supabase" });
    expect(res.status).toBe("ok");
    expect((res as any).data.limitation).toMatch(/not supported/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Supabase", () => {
  it("blocks destructive SQL everywhere and does NOT execute", async () => {
    const store = freshStore();
    seedAcme(store);
    const res = await pa.supabaseQuery(store, { environment: "staging", sql: "DROP TABLE users" });
    expect(res.status).toBe("blocked");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lastAudit(store)).toMatchObject({ result: "not_executed", policyDecision: "block" });
  });

  it("requires approval for a production DB write and does NOT execute", async () => {
    const store = freshStore();
    seedAcme(store);
    const res = await pa.supabaseQuery(store, {
      environment: "production",
      sql: "INSERT INTO users (id) VALUES (1)",
    });
    expect(res.status).toBe("approval_required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows a read-only SELECT and sends read_only=true", async () => {
    const store = freshStore();
    seedAcme(store);
    fetchMock.mockResolvedValueOnce(mockOk([{ count: 5 }]));
    const res = await pa.supabaseQuery(store, { environment: "production", sql: "SELECT count(*) FROM users" });
    expect(res.status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.read_only).toBe(true);
  });
});
