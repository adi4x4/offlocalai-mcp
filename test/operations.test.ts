import { describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { freshStore, seedAcme } from "./helpers.js";
import {
  createConnection,
  doctor,
  exportAuditLog,
  exportContextSnapshot,
  listConnections,
  simulateAction,
} from "../src/service.js";

describe("operational readiness", () => {
  it("creates and lists explicit provider connections without storing secrets", () => {
    const store = freshStore();

    const created = createConnection(store, {
      provider: "vercel",
      label: "team-a",
      envVar: "VERCEL_TEAM_A_TOKEN",
      vercelTeamId: "team_a",
    });

    expect(created).toMatchObject({
      provider: "vercel",
      label: "team-a",
      auth: { kind: "env", envVar: "VERCEL_TEAM_A_TOKEN" },
      scope: { vercelTeamId: "team_a" },
    });
    expect(JSON.stringify(created)).not.toContain("TOKEN_VALUE");
    expect(listConnections(store)).toEqual([created]);
  });

  it("rejects duplicate connection labels per provider", () => {
    const store = freshStore();
    createConnection(store, { provider: "github", label: "main", envVar: "GITHUB_TOKEN" });

    expect(() =>
      createConnection(store, { provider: "github", label: "main", envVar: "GITHUB_TOKEN_2" }),
    ).toThrow(/already exists/i);
  });

  it("simulates policy decisions without writing audit entries", () => {
    const store = freshStore();
    seedAcme(store);

    const decision = simulateAction(store, {
      project: "acme-crm",
      environment: "production",
      provider: "vercel",
      capability: "deploy",
    });

    expect(decision).toMatchObject({
      project: "acme-crm",
      environment: "production",
      provider: "vercel",
      capability: "deploy",
      effect: "approval_required",
      wouldExecute: false,
    });
    expect(store.readAudit()).toHaveLength(0);
  });

  it("reports doctor checks for mappings, env vars, and audit writability", () => {
    const store = freshStore();
    seedAcme(store);
    process.env.VERCEL_TOKEN = "vc_dummy";
    process.env.SUPABASE_ACCESS_TOKEN = "sb_dummy";
    mkdirSync(`${store.paths.audit}.lock`);

    const report = doctor(store, { project: "acme-crm", environment: "staging" });

    expect(report.status).toBe("fail");
    expect(report.summary.total).toBeGreaterThan(0);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "project", status: "pass" }),
        expect.objectContaining({ id: "environment", status: "pass" }),
        expect.objectContaining({ id: "mapping.github", status: "pass" }),
        expect.objectContaining({ id: "env.github", status: "warn" }),
        expect.objectContaining({ id: "env.vercel", status: "pass" }),
        expect.objectContaining({ id: "audit.writable", status: "fail" }),
      ]),
    );
  });

  it("exports audit entries as jsonl, csv, and markdown", () => {
    const store = freshStore();
    seedAcme(store);
    store.appendAudit({
      timestamp: "2026-06-09T00:00:00.000Z",
      projectSlug: "acme-crm",
      environment: "staging",
      provider: "vercel",
      tool: "get_vercel_deployments",
      actionSummary: "deployments acme-preview",
      policyDecision: "allow",
      result: "success",
      providerResource: "acme-preview",
    });

    expect(exportAuditLog(store, { project: "acme-crm", format: "jsonl" })).toContain('"tool":"get_vercel_deployments"');
    expect(exportAuditLog(store, { project: "acme-crm", format: "csv" })).toContain("timestamp,project,environment,provider,tool");
    expect(exportAuditLog(store, { project: "acme-crm", format: "markdown" })).toContain("| Timestamp | Project | Environment |");
  });

  it("exports context snapshots in machine and markdown formats", async () => {
    const store = freshStore();
    seedAcme(store);

    const json = await exportContextSnapshot(store, {
      project: "acme-crm",
      environment: "staging",
      format: "json",
    });
    const parsed = JSON.parse(json);
    expect(parsed.schema).toBe("offlocal.context.snapshot.v1");
    expect(parsed.context.project.slug).toBe("acme-crm");
    expect(parsed.context.focusedEnvironment).toBe("staging");

    const markdown = await exportContextSnapshot(store, {
      project: "acme-crm",
      environment: "staging",
      format: "markdown",
    });
    expect(markdown).toContain("# offlocal context snapshot: acme-crm");
    expect(markdown).toContain("Environment: staging");
  });
});
