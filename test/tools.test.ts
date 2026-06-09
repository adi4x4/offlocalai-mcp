import { describe, expect, it } from "vitest";
import { registerTools } from "../src/tools/index.js";
import { freshStore } from "./helpers.js";

type RegisteredTool = {
  config: {
    inputSchema: Record<string, { safeParse: (value: unknown) => { success: boolean } }>;
  };
};

function registeredTools(): Map<string, RegisteredTool> {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool(name: string, config: RegisteredTool["config"]) {
      tools.set(name, { config });
    },
  };

  registerTools(server as never, freshStore());
  return tools;
}

function inputSchema(tool: string): RegisteredTool["config"]["inputSchema"] {
  const registered = registeredTools().get(tool);
  if (!registered) {
    throw new Error(`Tool ${tool} was not registered`);
  }
  return registered.config.inputSchema;
}

describe("MCP tool schemas", () => {
  it("rejects blank required mutation strings before handlers run", () => {
    expect(inputSchema("create_project").name.safeParse("   ").success).toBe(false);
    expect(inputSchema("set_vercel_env_var").key.safeParse("").success).toBe(false);
    expect(inputSchema("set_railway_env_var").key.safeParse(" ").success).toBe(false);
    expect(inputSchema("query_supabase").sql.safeParse("\t").success).toBe(false);
    expect(inputSchema("create_stripe_product").name.safeParse(" ").success).toBe(false);
    expect(inputSchema("create_stripe_price").product.safeParse("").success).toBe(false);
    expect(inputSchema("approve_action").approvalId.safeParse(" ").success).toBe(false);
    expect(inputSchema("reject_action").approvalId.safeParse("").success).toBe(false);
    expect(inputSchema("map_provider_resource").connectionId.safeParse(" ").success).toBe(false);
    expect(inputSchema("create_connection").label.safeParse("").success).toBe(false);
    expect(inputSchema("create_connection").envVar.safeParse(" ").success).toBe(false);
  });

  it("rejects invalid numeric options before handlers run", () => {
    expect(inputSchema("list_audit_log").limit.safeParse(0).success).toBe(false);
    expect(inputSchema("get_vercel_deployments").limit.safeParse(-1).success).toBe(false);
    expect(inputSchema("get_app_logs").limit.safeParse(1.5).success).toBe(false);
    expect(inputSchema("set_policy_rule").priority.safeParse(-1).success).toBe(false);
    expect(inputSchema("create_stripe_price").unitAmount.safeParse(0).success).toBe(false);
  });

  it("rejects invalid approval status filters before handlers run", () => {
    expect(inputSchema("list_pending_approvals").status.safeParse("used").success).toBe(true);
    expect(inputSchema("list_pending_approvals").status.safeParse("waiting").success).toBe(false);
  });

  it("registers operational readiness tools", () => {
    const tools = registeredTools();
    expect(tools.has("doctor")).toBe(true);
    expect(tools.has("export_context")).toBe(true);
    expect(tools.has("list_connections")).toBe(true);
    expect(tools.has("create_connection")).toBe(true);
    expect(tools.has("simulate_action")).toBe(true);
    expect(tools.has("export_audit_log")).toBe(true);
    expect(inputSchema("export_audit_log").format.safeParse("markdown").success).toBe(true);
    expect(inputSchema("export_audit_log").format.safeParse("xml").success).toBe(false);
    expect(inputSchema("export_context").format.safeParse("json").success).toBe(true);
    expect(inputSchema("export_context").format.safeParse("xml").success).toBe(false);
    expect(tools.has("list_github_pull_requests")).toBe(true);
    expect(tools.has("list_github_branches")).toBe(true);
    expect(tools.has("get_github_status_checks")).toBe(true);
    expect(tools.has("discover_railway_resources")).toBe(true);
    expect(tools.has("get_supabase_logs")).toBe(true);
    expect(tools.has("apply_supabase_migration")).toBe(true);
    expect(tools.has("list_stripe_customers")).toBe(true);
    expect(tools.has("list_stripe_subscriptions")).toBe(true);
    expect(tools.has("list_stripe_invoices")).toBe(true);
    expect(inputSchema("get_github_status_checks").ref.safeParse("").success).toBe(false);
    expect(inputSchema("create_vercel_deployment").gitSource.safeParse({ type: "github", repoId: "123" }).success).toBe(true);
  });
});
