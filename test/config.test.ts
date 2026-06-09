import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshStore, acmeConfig } from "./helpers.js";
import { applyConfig, loadConfig } from "../src/config.js";
import { checkPolicy, ensureConnection, listProviderMappings, listEnvironments } from "../src/service.js";

function writeTempConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "offlocal-config-test-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, contents);
  return path;
}

describe("config seeding", () => {
  it("init/applyConfig creates project, environments, mappings, rules and persists state", () => {
    const store = freshStore();
    const result = applyConfig(store, acmeConfig());

    expect(result.createdProjects).toEqual(["acme-crm"]);
    expect(result.createdRules).toBe(6); // 4 require_approval + 2 block

    expect(listEnvironments(store, "acme-crm").map((e) => e.name).sort()).toEqual([
      "production",
      "staging",
    ]);
    // 4 providers × 2 environments = 8 mappings.
    expect(listProviderMappings(store, "acme-crm")).toHaveLength(8);

    // State persisted to disk.
    expect(existsSync(store.paths.state)).toBe(true);
  });

  it("is idempotent — re-applying skips existing projects", () => {
    const store = freshStore();
    applyConfig(store, acmeConfig());
    const second = applyConfig(store, acmeConfig());
    expect(second.createdProjects).toEqual([]);
    expect(second.skippedProjects).toEqual(["acme-crm"]);
  });

  it("policy from config gates production but leaves staging permissive", () => {
    const store = freshStore();
    applyConfig(store, acmeConfig());

    // require_approval: supabase.write → production approval, staging allowed.
    expect(
      checkPolicy(store, { project: "acme-crm", environment: "production", provider: "supabase", capability: "write" }).effect,
    ).toBe("approval_required");
    expect(
      checkPolicy(store, { project: "acme-crm", environment: "staging", provider: "supabase", capability: "write" }).effect,
    ).toBe("allow");

    // block: supabase.destructive_sql everywhere; provider.delete everywhere.
    expect(
      checkPolicy(store, { project: "acme-crm", environment: "staging", provider: "supabase", capability: "destructive_sql" }).effect,
    ).toBe("block");
    expect(
      checkPolicy(store, { project: "acme-crm", environment: "staging", provider: "github", capability: "delete" }).effect,
    ).toBe("block");
  });

  it("fails loudly when a provider mapping in config is malformed", () => {
    const store = freshStore();
    const config = acmeConfig();
    config.projects["acme-crm"]!.environments!.staging.github = { repo: "missing-slash" };

    expect(() => applyConfig(store, config)).toThrow(/github repo.*owner\/repo/i);
  });

  it("rejects malformed nested provider blocks before mutating state", () => {
    const store = freshStore();
    const config = acmeConfig() as any;
    config.projects["acme-crm"].environments.staging.github = "acme/acme-crm";

    expect(() => applyConfig(store, config)).toThrow(/projects\.acme-crm\.environments\.staging\.github.*object/i);
    expect(store.data.projects).toHaveLength(0);
    expect(store.data.environments).toHaveLength(0);
    expect(store.data.mappings).toHaveLength(0);
  });

  it("rejects malformed memory entries before mutating state", () => {
    const store = freshStore();
    const config = acmeConfig() as any;
    config.projects["acme-crm"].memory = [{ environment: "staging", tags: ["incident"] }];

    expect(() => applyConfig(store, config)).toThrow(/projects\.acme-crm\.memory\[0\]\.note/i);
    expect(store.data.projects).toHaveLength(0);
    expect(store.data.environments).toHaveLength(0);
    expect(store.data.mappings).toHaveLength(0);
  });

  it("rejects invalid connection ids from config before mutating state", () => {
    const store = freshStore();
    const config = acmeConfig() as any;
    config.projects["acme-crm"].environments.staging.vercel.connection_id = "";

    expect(() => applyConfig(store, config)).toThrow(/vercel\.connection_id.*non-empty string/i);
    expect(store.data.projects).toHaveLength(0);
    expect(store.data.environments).toHaveLength(0);
    expect(store.data.mappings).toHaveLength(0);
  });

  it("seeds provider mappings with explicit connection ids from config", () => {
    const store = freshStore();
    const connectionId = ensureConnection(store, "github");
    const config = acmeConfig();
    config.projects["acme-crm"]!.environments!.staging.github = {
      repo: "acme/acme-crm",
      connection_id: connectionId,
    } as any;

    applyConfig(store, config);

    expect(
      listProviderMappings(store, "acme-crm").find((m) => m.environment === "staging" && m.provider === "github"),
    ).toMatchObject({ connectionId });
  });

  it("fails loudly when config references a missing provider connection", () => {
    const store = freshStore();
    const config = acmeConfig();
    config.projects["acme-crm"]!.environments!.staging.github = {
      repo: "acme/acme-crm",
      connection_id: "conn_missing",
    } as any;

    expect(() => applyConfig(store, config)).toThrow(/connection.*not found/i);
  });

  it("fails loudly when a policy token in config is unknown", () => {
    const store = freshStore();
    const config = acmeConfig();
    config.policy.require_approval = ["vercel.fly-to-mars"];

    expect(() => applyConfig(store, config)).toThrow(/unknown policy token.*vercel\.fly-to-mars/i);
    expect(store.data.projects).toHaveLength(0);
    expect(store.data.environments).toHaveLength(0);
    expect(store.data.mappings).toHaveLength(0);
  });

  it("fails loudly when config yaml is not an object", () => {
    const path = writeTempConfig("- just\n- a list\n");

    expect(() => loadConfig(path)).toThrow(/config.*object/i);
  });

  it("fails loudly when policy lists are not arrays", () => {
    const store = freshStore();
    const config = acmeConfig() as any;
    config.policy.require_approval = "vercel.deploy";

    expect(() => applyConfig(store, config)).toThrow(/policy\.require_approval.*array/i);
  });

  it("fails loudly when project environments is not an object", () => {
    const store = freshStore();
    const config = acmeConfig() as any;
    config.projects["acme-crm"].environments = ["staging"];

    expect(() => applyConfig(store, config)).toThrow(/projects\.acme-crm\.environments.*object/i);
  });

  it("fails loudly when project memory is not an array", () => {
    const store = freshStore();
    const config = acmeConfig() as any;
    config.projects["acme-crm"].memory = { note: "not a list" };

    expect(() => applyConfig(store, config)).toThrow(/projects\.acme-crm\.memory.*array/i);
  });
});
