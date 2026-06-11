import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { freshStore, seedAcme } from "./helpers.js";
import * as pa from "../src/provider-actions.js";
import {
  listAuditLog,
  mapProviderResource,
  addConnection,
  listConnections,
  createProject,
  addEnvironment,
} from "../src/service.js";
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

describe("Railway logs", () => {
  function mapRailway(store: Store) {
    mapProviderResource(store, {
      project: "acme-crm",
      environment: "staging",
      provider: "railway",
      resource: { provider: "railway", projectId: "rw_proj_1", environmentId: "rw_env_1", serviceId: "rw_svc_1" },
    });
  }

  /** Route a mocked fetch (GraphQL POST) by inspecting the query body. */
  function routeRailway(opts: { project?: any; deployments?: any[]; logs?: any[]; errors?: any[] }) {
    return (_url: string, init?: any) => {
      if (opts.errors) return mockOk({ errors: opts.errors });
      const q = init?.body ? JSON.parse(init.body).query ?? "" : "";
      if (q.includes("deploymentLogs")) return mockOk({ data: { deploymentLogs: opts.logs ?? [] } });
      if (q.includes("deployments(")) {
        return mockOk({ data: { deployments: { edges: (opts.deployments ?? []).map((node) => ({ node })) } } });
      }
      if (q.includes("project(")) return mockOk({ data: { project: opts.project ?? null } });
      return mockOk({ data: {} });
    };
  }

  const RW_LATEST = { id: "rw_dpl_1", status: "FAILED", staticUrl: "acme.up.railway.app", createdAt: "2026-06-09T12:00:00Z" };

  beforeEach(() => {
    process.env.RAILWAY_TOKEN = "rw_dummy";
  });

  it("get_railway_logs resolves the latest deployment and normalizes severity", async () => {
    const store = freshStore();
    seedAcme(store);
    mapRailway(store);
    fetchMock.mockImplementation(async (url: string, init: any) =>
      routeRailway({
        deployments: [RW_LATEST],
        logs: [
          { timestamp: "2026-06-09T12:00:01Z", severity: "info", message: "Starting container" },
          { timestamp: "2026-06-09T12:00:02Z", severity: "err", message: "Boom: missing DATABASE_URL" },
        ],
      })(url, init),
    );

    const res = await pa.railwayLogs(store, { environment: "staging" });
    expect(res.status).toBe("ok");
    const data = (res as any).data;
    expect(data.resource.deployment_id).toBe("rw_dpl_1");
    expect(data.resource.deployment_status).toBe("FAILED");
    expect(data.resource.deployment_url).toBe("https://acme.up.railway.app");
    expect(data.logs).toHaveLength(2);
    expect(data.logs[1]).toMatchObject({ level: "error", message: "Boom: missing DATABASE_URL" });
    expect(lastAudit(store)).toMatchObject({ result: "success", provider: "railway", tool: "get_railway_logs" });
  });

  it("get_app_logs with no provider reads BOTH vercel and railway (vercel first)", async () => {
    const store = freshStore();
    seedAcme(store);
    mapRailway(store);
    fetchMock.mockImplementation(async (url: string, init: any) => {
      if (url.includes("backboard.railway")) {
        return routeRailway({ deployments: [RW_LATEST], logs: [{ timestamp: "t", severity: "info", message: "rw" }] })(url, init);
      }
      // Vercel REST
      if (url.includes("/v7/deployments")) return mockOk({ deployments: [{ uid: "vc_1", url: "v.app", readyState: "READY", created: 1 }] });
      if (/\/v3\/deployments\/[^/]+\/events/.test(url)) return mockOk([{ type: "stdout", created: 1, text: "vc" }]);
      return mockOk({});
    });

    const res = await pa.appLogs(store, { environment: "staging" });
    expect(res.status).toBe("ok");
    expect(res.providers.map((p: any) => p.provider)).toEqual(["vercel", "railway"]);
  });

  it("get_latest_deployment_logs works for provider=railway", async () => {
    const store = freshStore();
    seedAcme(store);
    mapRailway(store);
    fetchMock.mockImplementation(async (url: string, init: any) =>
      routeRailway({ deployments: [RW_LATEST], logs: [] })(url, init),
    );
    const res = await pa.latestDeploymentLogs(store, { environment: "staging", provider: "railway" });
    expect(res.status).toBe("ok");
    expect((res as any).data.resource.deployment_id).toBe("rw_dpl_1");
    // No log lines -> a clear limitation, still ok + audited.
    expect((res as any).data.limitation).toBeTruthy();
    expect(lastAudit(store)).toMatchObject({ provider: "railway", tool: "get_latest_deployment_logs", result: "success" });
  });

  it("surfaces a GraphQL error as a clean error envelope", async () => {
    const store = freshStore();
    seedAcme(store);
    mapRailway(store);
    fetchMock.mockImplementation(async (url: string, init: any) =>
      routeRailway({ errors: [{ message: "Not Authorized" }] })(url, init),
    );
    const res = await pa.railwayDeployments(store, { environment: "staging" });
    expect(res.status).toBe("error");
    expect((res as any).error).toMatch(/Not Authorized/);
  });
});

describe("Railway writes", () => {
  function mapRailwayTo(store: Store, environment: string) {
    mapProviderResource(store, {
      project: "acme-crm",
      environment,
      provider: "railway",
      resource: { provider: "railway", projectId: "rw_proj_1", environmentId: "rw_env_1", serviceId: "rw_svc_1" },
    });
  }

  function routeMutations() {
    return (_url: string, init?: any) => {
      const q = init?.body ? JSON.parse(init.body).query ?? "" : "";
      if (q.includes("environmentTriggersDeploy")) return mockOk({ data: { environmentTriggersDeploy: "rw_dpl_new" } });
      if (q.includes("deploymentRedeploy")) return mockOk({ data: { deploymentRedeploy: { id: "rw_dpl_re", status: "BUILDING" } } });
      if (q.includes("variableUpsert")) return mockOk({ data: { variableUpsert: true } });
      return mockOk({ data: {} });
    };
  }

  beforeEach(() => {
    process.env.RAILWAY_TOKEN = "rw_dummy";
  });

  it("allows and executes a staging deploy", async () => {
    const store = freshStore();
    seedAcme(store);
    mapRailwayTo(store, "staging");
    fetchMock.mockImplementation(async (url: string, init: any) => routeMutations()(url, init));
    const res = await pa.railwayCreateDeployment(store, { environment: "staging" });
    expect(res.status).toBe("ok");
    expect((res as any).data.deploymentId).toBe("rw_dpl_new");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastAudit(store)).toMatchObject({ result: "success", provider: "railway", tool: "create_railway_deployment" });
  });

  it("requires approval for a production deploy and does NOT execute", async () => {
    const store = freshStore();
    seedAcme(store);
    mapRailwayTo(store, "production");
    fetchMock.mockImplementation(async (url: string, init: any) => routeMutations()(url, init));
    const res = await pa.railwayCreateDeployment(store, { environment: "production" });
    expect(res.status).toBe("approval_required");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lastAudit(store)).toMatchObject({ result: "not_executed", policyDecision: "approval_required" });
  });

  it("requires approval for a production variable change and does NOT execute", async () => {
    const store = freshStore();
    seedAcme(store);
    mapRailwayTo(store, "production");
    fetchMock.mockImplementation(async (url: string, init: any) => routeMutations()(url, init));
    const res = await pa.railwaySetEnvVar(store, { environment: "production", key: "DATABASE_URL", value: "postgres://..." });
    expect(res.status).toBe("approval_required");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows and executes a staging variable change", async () => {
    const store = freshStore();
    seedAcme(store);
    mapRailwayTo(store, "staging");
    fetchMock.mockImplementation(async (url: string, init: any) => routeMutations()(url, init));
    const res = await pa.railwaySetEnvVar(store, { environment: "staging", key: "FEATURE_FLAG", value: "on" });
    expect(res.status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.variables.input).toMatchObject({ name: "FEATURE_FLAG", value: "on", environmentId: "rw_env_1" });
  });
});

describe("Multi-account connections", () => {
  it("routes each project to its own provider token via named connections", async () => {
    const store = freshStore();
    createProject(store, { name: "Client A", slug: "client-a" });
    addEnvironment(store, { project: "client-a", name: "staging" });
    createProject(store, { name: "Client B", slug: "client-b" });
    addEnvironment(store, { project: "client-b", name: "staging" });

    addConnection(store, { provider: "vercel", label: "acct-a", envVar: "VC_A" });
    addConnection(store, { provider: "vercel", label: "acct-b", envVar: "VC_B" });
    mapProviderResource(store, {
      project: "client-a",
      environment: "staging",
      provider: "vercel",
      resource: { provider: "vercel", projectId: "a-proj" },
      connection: "acct-a",
    });
    mapProviderResource(store, {
      project: "client-b",
      environment: "staging",
      provider: "vercel",
      resource: { provider: "vercel", projectId: "b-proj" },
      connection: "acct-b",
    });

    process.env.VC_A = "tokenA";
    process.env.VC_B = "tokenB";
    fetchMock.mockImplementation(async () => mockOk({ deployments: [] }));

    await pa.vercelDeployments(store, { project: "client-a", environment: "staging" });
    await pa.vercelDeployments(store, { project: "client-b", environment: "staging" });

    const h0 = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    const h1 = (fetchMock.mock.calls[1]![1] as RequestInit).headers as Record<string, string>;
    expect(h0.Authorization).toBe("Bearer tokenA");
    expect(h1.Authorization).toBe("Bearer tokenB");
  });

  it("rejects a duplicate connection label for the same provider", () => {
    const store = freshStore();
    addConnection(store, { provider: "vercel", label: "acct-a", envVar: "VC_A" });
    expect(() => addConnection(store, { provider: "vercel", label: "acct-a", envVar: "VC_X" })).toThrow(/already exists/);
  });

  it("list_provider_connections reports token presence without exposing values", () => {
    const store = freshStore();
    addConnection(store, { provider: "vercel", label: "acct-a", envVar: "VC_PRESENT" });
    addConnection(store, { provider: "railway", label: "rw-a", envVar: "VC_ABSENT" });
    process.env.VC_PRESENT = "secret-value";
    delete process.env.VC_ABSENT;

    const conns = listConnections(store);
    const a = conns.find((c) => c.label === "acct-a")!;
    expect(a).toMatchObject({ provider: "vercel", envVar: "VC_PRESENT", tokenPresent: true });
    expect(JSON.stringify(conns)).not.toContain("secret-value");
    expect(conns.find((c) => c.label === "rw-a")!.tokenPresent).toBe(false);
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
