import { describe, it, expect } from "vitest";
import { freshStore, seedAcme } from "./helpers.js";
import {
  addEnvironment,
  createProject,
  getProjectContext,
  listEnvironments,
  listProviderMappings,
  getProviderMapping,
  mapProviderResource,
  readProjectMemory,
  writeProjectMemory,
  listAuditLog,
} from "../src/service.js";

describe("project + environment lifecycle", () => {
  it("creates a project and selects it by default", () => {
    const store = freshStore();
    const p = createProject(store, { name: "Acme CRM" });
    expect(p.slug).toBe("acme-crm");
    expect(store.data.selectedProjectId).toBe(p.id);
  });

  it("rejects duplicate project slugs", () => {
    const store = freshStore();
    createProject(store, { name: "Acme CRM" });
    expect(() => createProject(store, { name: "Acme CRM" })).toThrow(/already exists/);
  });

  it("adds environments and infers kind from name", () => {
    const store = freshStore();
    createProject(store, { name: "Acme CRM" });
    const staging = addEnvironment(store, { name: "staging" });
    const prod = addEnvironment(store, { name: "production" });
    expect(staging.kind).toBe("staging");
    expect(staging.isProduction).toBe(false);
    expect(prod.kind).toBe("production");
    expect(prod.isProduction).toBe(true);
    expect(listEnvironments(store)).toHaveLength(2);
  });
});

describe("provider mappings", () => {
  it("maps and retrieves a provider resource", () => {
    const store = freshStore();
    createProject(store, { name: "Acme CRM" });
    addEnvironment(store, { name: "staging" });
    mapProviderResource(store, {
      environment: "staging",
      provider: "github",
      resource: { provider: "github", owner: "acme", repo: "acme-crm" },
    });
    const m = getProviderMapping(store, { environment: "staging", provider: "github" });
    expect(m.resource).toMatchObject({ owner: "acme", repo: "acme-crm" });
    expect(listProviderMappings(store)).toHaveLength(1);
  });

  it("replaces an existing mapping for the same env+provider", () => {
    const store = freshStore();
    createProject(store, { name: "Acme CRM" });
    addEnvironment(store, { name: "staging" });
    mapProviderResource(store, {
      environment: "staging",
      provider: "stripe",
      resource: { provider: "stripe", mode: "test" },
    });
    mapProviderResource(store, {
      environment: "staging",
      provider: "stripe",
      resource: { provider: "stripe", mode: "live" },
    });
    expect(listProviderMappings(store)).toHaveLength(1);
    const m = getProviderMapping(store, { environment: "staging", provider: "stripe" });
    expect(m.resource).toMatchObject({ mode: "live" });
  });
});

describe("get_project_context (killer tool)", () => {
  it("returns rich per-environment context, action buckets, memory, and a summary", async () => {
    const store = freshStore();
    seedAcme(store);
    const ctx = await getProjectContext(store, "acme-crm");
    expect(ctx.environments.map((e) => e.environment).sort()).toEqual(["production", "staging"]);

    const prod = ctx.environments.find((e) => e.environment === "production")!;
    expect(prod.isProduction).toBe(true);
    // Mappings surfaced as source/deployment/database/payments.
    expect(prod.source.githubRepo).toBe("acme/acme-crm");
    expect(prod.deployment.vercelProject).toBe("acme-crm-prod");
    expect(prod.database.supabaseProjectRef).toBe("sb_prod_ref");
    expect(prod.payments.stripeMode).toBe("live");

    // Action buckets reflect policy.
    expect(prod.allowed.some((a) => /inspect GitHub repo/.test(a))).toBe(true);
    expect(prod.approvalRequired.some((a) => /deploy to Vercel/.test(a))).toBe(true);
    expect(prod.blocked.some((a) => /destructive SQL/.test(a))).toBe(true);

    const staging = ctx.environments.find((e) => e.environment === "staging")!;
    expect(staging.payments.stripeMode).toBe("test");
    // Staging deploy is allowed (not approval-required).
    expect(staging.allowed.some((a) => /deploy to Vercel/.test(a))).toBe(true);
    // Incident memory surfaces as the last known issue.
    expect(staging.deployment.lastKnownIssue).toMatch(/DATABASE_URL/);

    // Human-readable summary present.
    expect(ctx.summary).toMatch(/Project: acme-crm/);
    expect(ctx.summary).toMatch(/Approval required:/);
  });

  it("focuses on a single environment when one is given", async () => {
    const store = freshStore();
    seedAcme(store);
    const ctx = await getProjectContext(store, "acme-crm", "staging");
    expect(ctx.focusedEnvironment).toBe("staging");
    expect(ctx.environments).toHaveLength(1);
  });
});

describe("project memory", () => {
  it("writes and reads memory scoped by environment", () => {
    const store = freshStore();
    seedAcme(store);
    writeProjectMemory(store, {
      project: "acme-crm",
      environment: "staging",
      note: "Use Supabase staging for tests.",
      tags: ["supabase"],
    });
    const stagingMem = readProjectMemory(store, { project: "acme-crm", environment: "staging" });
    expect(stagingMem.some((m) => /Supabase staging/.test(m.note))).toBe(true);
    // Project-wide read includes the production-scoped seed note too.
    const all = readProjectMemory(store, { project: "acme-crm" });
    expect(all.length).toBeGreaterThanOrEqual(2);
  });
});

describe("audit log", () => {
  it("starts empty and is filterable by project", () => {
    const store = freshStore();
    seedAcme(store);
    expect(listAuditLog(store, { project: "acme-crm" })).toHaveLength(0);
  });
});
