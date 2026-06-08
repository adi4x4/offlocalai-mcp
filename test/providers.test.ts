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
