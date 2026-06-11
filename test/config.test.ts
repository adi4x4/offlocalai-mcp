import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { freshStore, acmeConfig } from "./helpers.js";
import { applyConfig } from "../src/config.js";
import { checkPolicy, listProviderMappings, listEnvironments } from "../src/service.js";

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

  it("seeds named connections and binds a mapping to one", () => {
    const store = freshStore();
    applyConfig(store, {
      connections: [{ provider: "vercel", label: "client-a", env_var: "VERCEL_TOKEN_CLIENT_A" }],
      projects: {
        "acme-a": {
          environments: {
            production: { kind: "production", vercel: { project: "a-prod", connection: "client-a" } },
          },
        },
      },
    });
    const conn = store.data.connections.find((c) => c.label === "client-a")!;
    expect(conn.auth.envVar).toBe("VERCEL_TOKEN_CLIENT_A");
    const mapping = listProviderMappings(store, "acme-a").find((m) => m.provider === "vercel")!;
    expect(mapping.connection).toBe("client-a");
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
});
