import { describe, expect, it, vi } from "vitest";
import { runGuarded } from "../src/actions.js";
import { resolveEnvironment, resolveProject } from "../src/resolve.js";
import { freshStore, seedAcme } from "./helpers.js";

function stagingContext() {
  const store = freshStore();
  seedAcme(store);
  const project = resolveProject(store, "acme-crm");
  const environment = resolveEnvironment(store, project, "staging");
  return { store, project, environment };
}

describe("runGuarded invariants", () => {
  it("does not execute blocked actions and writes exactly one audit entry", async () => {
    const { store, project, environment } = stagingContext();
    const exec = vi.fn(async () => ({ ok: true }));

    const res = await runGuarded(
      store,
      {
        project,
        environment,
        provider: "supabase",
        capability: "destructive_sql",
        tool: "mutation_test_blocked",
        summary: "drop table",
        resourceLabel: "sb_staging_ref",
      },
      exec,
    );

    expect(res.status).toBe("blocked");
    expect(exec).not.toHaveBeenCalled();
    expect(store.readAudit()).toHaveLength(1);
    expect(store.readAudit()[0]).toMatchObject({ tool: "mutation_test_blocked", result: "not_executed" });
  });

  it("executes allowed actions once and writes exactly one success audit entry", async () => {
    const { store, project, environment } = stagingContext();
    const exec = vi.fn(async () => ({ ok: true }));

    const res = await runGuarded(
      store,
      {
        project,
        environment,
        provider: "github",
        capability: "read",
        tool: "mutation_test_allowed",
        summary: "read repo",
      },
      exec,
    );

    expect(res.status).toBe("ok");
    expect(exec).toHaveBeenCalledTimes(1);
    expect(store.readAudit()).toHaveLength(1);
    expect(store.readAudit()[0]).toMatchObject({ tool: "mutation_test_allowed", result: "success" });
  });

  it("records one error audit entry when an allowed provider call throws", async () => {
    const { store, project, environment } = stagingContext();
    const exec = vi.fn(async () => {
      throw new Error("provider failed");
    });

    const res = await runGuarded(
      store,
      {
        project,
        environment,
        provider: "github",
        capability: "read",
        tool: "mutation_test_error",
        summary: "read repo",
      },
      exec,
    );

    expect(res.status).toBe("error");
    expect(exec).toHaveBeenCalledTimes(1);
    expect(store.readAudit()).toHaveLength(1);
    expect(store.readAudit()[0]).toMatchObject({ tool: "mutation_test_error", result: "error", errorMessage: "provider failed" });
  });
});
