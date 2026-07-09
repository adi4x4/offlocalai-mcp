import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { freshStore, seedAcme } from "./helpers.js";
import { deploy, deployStatus } from "../src/deploy.js";
import { createProject, addEnvironment, mapProviderResource, listAuditLog } from "../src/service.js";
import type { Store } from "../src/storage.js";

/**
 * Deploy orchestration: the unified `deploy` tool triggers through the guarded
 * flow (policy + audit intact), then polls to a terminal state. These tests use
 * a mocked fetch so a deployment is "terminal" on the first poll — no waiting.
 */

let fetchMock: ReturnType<typeof vi.fn>;

function mockOk(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  fetchMock = vi.fn(async () => mockOk({}));
  vi.stubGlobal("fetch", fetchMock);
  process.env.RENDER_API_KEY = "rnd_dummy";
  process.env.VERCEL_TOKEN = "vc_dummy";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A project with a single Render service mapped to one env (no other deploy target). */
function renderOnly(store: Store, envName: string) {
  createProject(store, { name: "Rd", slug: "rd" });
  addEnvironment(store, { project: "rd", name: envName, kind: envName === "production" ? "production" : "staging" });
  mapProviderResource(store, {
    project: "rd",
    environment: envName,
    provider: "render",
    resource: { provider: "render", serviceId: "srv-1", serviceName: "acme-web" },
  });
}

function routeRender(opts: { deployStatus?: string; url?: string; logs?: any[] }) {
  return (url: string, init?: any) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.includes("/env-vars/")) return mockOk({});
    if (url.includes("/logs")) return mockOk({ logs: opts.logs ?? [] });
    if (/\/services\/[^/]+\/deploys\/[^/]+/.test(url)) return mockOk({ id: "dep-1", status: opts.deployStatus ?? "live" });
    if (/\/services\/[^/]+\/deploys/.test(url)) {
      if (method === "POST") return mockOk({ id: "dep-1", status: "created" });
      return mockOk([{ deploy: { id: "dep-1", status: opts.deployStatus ?? "live" } }]);
    }
    if (/\/services\/[^/]+$/.test(url)) {
      return mockOk({ id: "srv-1", ownerId: "tea-1", serviceDetails: { url: opts.url ?? "https://acme-web.onrender.com" } });
    }
    return mockOk({});
  };
}

describe("deploy — Render", () => {
  it("deploys a staging service and returns the live URL", async () => {
    const store = freshStore();
    renderOnly(store, "staging");
    fetchMock.mockImplementation(async (url: string, init: any) => routeRender({ deployStatus: "live" })(url, init));

    const res = await deploy(store, { project: "rd", environment: "staging" });
    expect(res.status).toBe("deployed");
    expect(res.provider).toBe("render");
    expect(res.deploymentId).toBe("dep-1");
    expect(res.url).toBe("https://acme-web.onrender.com");
    // The trigger is audited as a real deploy action.
    expect(listAuditLog(store, { project: "rd" })[0]).toMatchObject({
      provider: "render",
      tool: "create_render_deployment",
      result: "success",
    });
  });

  it("returns approval_required for a production deploy WITHOUT triggering", async () => {
    const store = freshStore();
    renderOnly(store, "production");
    fetchMock.mockImplementation(async (url: string, init: any) => routeRender({})(url, init));

    const res = await deploy(store, { project: "rd", environment: "production" });
    expect(res.status).toBe("approval_required");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.reason).toBeTruthy();
    expect(res.suggested_next_step).toBeTruthy();
  });

  it("returns failed with a tail of logs when the deploy fails", async () => {
    const store = freshStore();
    renderOnly(store, "staging");
    fetchMock.mockImplementation(async (url: string, init: any) =>
      routeRender({
        deployStatus: "build_failed",
        logs: [{ timestamp: "t", level: "error", message: "Error: DATABASE_URL is missing" }],
      })(url, init),
    );

    const res = await deploy(store, { project: "rd", environment: "staging" });
    expect(res.status).toBe("failed");
    expect(res.state).toBe("build_failed");
    expect(res.logs?.[0]).toMatchObject({ level: "error", message: "Error: DATABASE_URL is missing" });
  });

  it("wait:false returns 'deploying' immediately after triggering", async () => {
    const store = freshStore();
    renderOnly(store, "staging");
    fetchMock.mockImplementation(async (url: string, init: any) => routeRender({})(url, init));

    const res = await deploy(store, { project: "rd", environment: "staging", wait: false });
    expect(res.status).toBe("deploying");
    expect(res.deploymentId).toBe("dep-1");
    // Only the trigger POST happened — no status polling.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("deploy — Vercel", () => {
  function routeVercel(readyState: string) {
    return (url: string, init?: any) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/v13/deployments/")) return mockOk({ id: "dpl-1", readyState, url: "acme-crm-preview.vercel.app" });
      if (method === "POST" && url.includes("/v13/deployments")) return mockOk({ id: "dpl-1", readyState: "QUEUED" });
      return mockOk({});
    };
  }

  it("deploys staging (Vercel is the only mapped target) and returns the URL", async () => {
    const store = freshStore();
    seedAcme(store); // maps vercel to staging; railway/render not mapped
    fetchMock.mockImplementation(async (url: string, init: any) => routeVercel("READY")(url, init));

    const res = await deploy(store, { project: "acme-crm", environment: "staging" });
    expect(res.status).toBe("deployed");
    expect(res.provider).toBe("vercel");
    expect(res.url).toBe("https://acme-crm-preview.vercel.app");
  });

  it("requires approval for a production Vercel deploy", async () => {
    const store = freshStore();
    seedAcme(store);
    fetchMock.mockImplementation(async (url: string, init: any) => routeVercel("READY")(url, init));
    const res = await deploy(store, { project: "acme-crm", environment: "production" });
    expect(res.status).toBe("approval_required");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("deploy — provider resolution", () => {
  it("errors when no deployable provider is mapped", async () => {
    const store = freshStore();
    createProject(store, { name: "Empty", slug: "empty" });
    addEnvironment(store, { project: "empty", name: "staging" });
    await expect(deploy(store, { project: "empty", environment: "staging" })).rejects.toThrow(/No deployable provider/);
  });

  it("errors on ambiguity and is resolved by an explicit provider", async () => {
    const store = freshStore();
    createProject(store, { name: "Two", slug: "two" });
    addEnvironment(store, { project: "two", name: "staging" });
    mapProviderResource(store, {
      project: "two",
      environment: "staging",
      provider: "render",
      resource: { provider: "render", serviceId: "srv-1" },
    });
    mapProviderResource(store, {
      project: "two",
      environment: "staging",
      provider: "railway",
      resource: { provider: "railway", projectId: "rw-1", environmentId: "env-1", serviceId: "svc-1" },
    });

    await expect(deploy(store, { project: "two", environment: "staging" })).rejects.toThrow(/multiple deploy targets/);

    // Explicit provider disambiguates.
    process.env.RENDER_API_KEY = "rnd_dummy";
    fetchMock.mockImplementation(async (url: string, init: any) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (/\/services\/[^/]+\/deploys\/[^/]+/.test(url)) return mockOk({ id: "dep-1", status: "live" });
      if (method === "POST" && /\/services\/[^/]+\/deploys/.test(url)) return mockOk({ id: "dep-1", status: "created" });
      if (/\/services\/[^/]+$/.test(url)) return mockOk({ id: "srv-1", ownerId: "tea-1", serviceDetails: { url: "https://x.onrender.com" } });
      return mockOk({});
    });
    const res = await deploy(store, { project: "two", environment: "staging", provider: "render" });
    expect(res.status).toBe("deployed");
    expect(res.provider).toBe("render");
  });
});

describe("get_deploy_status", () => {
  it("reports a deployment's status without triggering a deploy", async () => {
    const store = freshStore();
    renderOnly(store, "staging");
    fetchMock.mockImplementation(async (url: string, init: any) => routeRender({ deployStatus: "live" })(url, init));
    const res = await deployStatus(store, { project: "rd", environment: "staging", deploymentId: "dep-1" });
    expect(res.status).toBe("deployed");
    expect(res.url).toBe("https://acme-web.onrender.com");
    // No POST /deploys trigger was issued.
    const posts = fetchMock.mock.calls.filter((c: any) => (c[1]?.method ?? "GET").toUpperCase() === "POST");
    expect(posts).toHaveLength(0);
  });
});
