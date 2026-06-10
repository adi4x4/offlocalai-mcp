import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Store } from "../storage.js";
import * as svc from "../service.js";
import * as pa from "../provider-actions.js";
import { PROVIDER_IDS } from "../types.js";

/**
 * Registers every offlocal.ai tool on the MCP server. Handlers are thin: they
 * validate args (via Zod), call the service / provider-action layer, and return
 * the result as a JSON text block. Failures are returned with isError:true and
 * an actionable message (never a raw throw across the wire).
 */

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ status: "error", error: message }, null, 2) }],
    isError: true,
  };
}

/** Wrap a handler so thrown errors become clean isError responses. */
function guard<A>(fn: (args: A) => unknown | Promise<unknown>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      const result = await fn(args);
      // Provider actions already return a {status} envelope; pass through.
      return ok(result);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  };
}

const provider = z.enum(["github", "vercel", "supabase", "stripe", "railway", "namecheap", "neon"]);
const capability = z.enum(["read", "write", "deploy", "env_change", "delete", "destructive_sql", "purchase"]);
const nonEmptyString = (description?: string) => {
  const schema = z.string().trim().min(1);
  return description ? schema.describe(description) : schema;
};
const optionalNonEmptyString = (description?: string) => nonEmptyString(description).optional();
const positiveInt = (description?: string) => {
  const schema = z.number().int().positive();
  return description ? schema.describe(description) : schema;
};
const nonNegativeInt = (description?: string) => {
  const schema = z.number().int().nonnegative();
  return description ? schema.describe(description) : schema;
};

export function registerTools(server: McpServer, store: Store): void {
  // --- Project / workspace -------------------------------------------------

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description: "List all known projects and which one is currently selected.",
      inputSchema: {},
    },
    guard(() => ({ status: "ok", projects: svc.listProjects(store) })),
  );

  server.registerTool(
    "create_project",
    {
      title: "Create project",
      description: "Create a new project in the default workspace.",
      inputSchema: {
        name: nonEmptyString("Display name, e.g. 'Your Project'"),
        slug: optionalNonEmptyString("Optional id-safe slug; derived from name if omitted"),
        description: z.string().optional(),
      },
    },
    guard((a: { name: string; slug?: string; description?: string }) => ({
      status: "ok",
      project: svc.createProject(store, a),
    })),
  );

  server.registerTool(
    "select_project",
    {
      title: "Select project",
      description: "Set the active project used by tools that omit an explicit project arg.",
      inputSchema: { project: nonEmptyString("Project id or slug") },
    },
    guard((a: { project: string }) => ({ status: "ok", project: svc.selectProject(store, a.project) })),
  );

  server.registerTool(
    "get_project_context",
    {
      title: "Get project context",
      description:
        "THE tool to call FIRST. Returns the full production context for a project/environment: " +
        "GitHub repo, Vercel project + live latest deployment status/URL/failure, Supabase project, " +
        "Stripe mode, what is allowed / blocked / approval-required, project memory, recent audit " +
        "history, suggested safe next actions, and a human-readable summary. Pass `environment` to " +
        "focus on one (recommended); otherwise all environments are returned.",
      inputSchema: {
        project: optionalNonEmptyString("Project id or slug; uses selected if omitted"),
        environment: optionalNonEmptyString("Environment id or name to focus on (e.g. 'staging')"),
      },
    },
    guard(async (a: { project?: string; environment?: string }) => ({
      status: "ok",
      context: await svc.getProjectContext(store, a.project, a.environment),
    })),
  );

  server.registerTool(
    "export_context",
    {
      title: "Export context snapshot",
      description: "Export a versioned project context snapshot as JSON or Markdown.",
      inputSchema: {
        project: optionalNonEmptyString("Project id or slug; uses selected if omitted"),
        environment: optionalNonEmptyString("Environment id or name to focus on"),
        format: z.enum(["json", "markdown"]),
      },
    },
    guard(async (a: { project?: string; environment?: string; format: "json" | "markdown" }) => ({
      status: "ok",
      format: a.format,
      text: await svc.exportContextSnapshot(store, a),
    })),
  );

  server.registerTool(
    "add_environment",
    {
      title: "Add environment",
      description: "Add an environment (e.g. staging, production) to a project.",
      inputSchema: {
        project: optionalNonEmptyString(),
        name: nonEmptyString("e.g. 'staging' or 'production'"),
        kind: z.enum(["development", "staging", "production"]).optional().describe("Inferred from name if omitted"),
      },
    },
    guard((a: { project?: string; name: string; kind?: "development" | "staging" | "production" }) => ({
      status: "ok",
      environment: svc.addEnvironment(store, a),
    })),
  );

  server.registerTool(
    "list_environments",
    {
      title: "List environments",
      description: "List environments for a project.",
      inputSchema: { project: optionalNonEmptyString() },
    },
    guard((a: { project?: string }) => ({ status: "ok", environments: svc.listEnvironments(store, a.project) })),
  );

  // --- Provider mappings ---------------------------------------------------

  server.registerTool(
    "map_provider_resource",
    {
      title: "Map provider resource",
      description:
        "Bind a provider resource to a project environment. Examples of `resource`: " +
        "{provider:'github',owner:'your-org',repo:'your-repo'}, {provider:'vercel',projectId:'your-vercel-project'}, " +
        "{provider:'supabase',projectRef:'your_project_ref'}, {provider:'stripe',mode:'live'}.",
      inputSchema: {
        project: optionalNonEmptyString(),
        environment: nonEmptyString("Environment id or name"),
        provider,
        connectionId: optionalNonEmptyString("Optional provider connection id to use for this mapping"),
        resource: z
          .record(z.any())
          .describe("Resource object including a 'provider' field matching `provider`"),
      },
    },
    guard((a: { project?: string; environment: string; provider: (typeof PROVIDER_IDS)[number]; connectionId?: string; resource: any }) => {
      const res = svc.mapProviderResource(store, {
        project: a.project,
        environment: a.environment,
        provider: a.provider,
        connectionId: a.connectionId,
        resource: { provider: a.provider, ...a.resource },
      });
      return { status: "ok", project: res.project.slug, environment: res.environment.name, mappingId: res.mappingId };
    }),
  );

  server.registerTool(
    "list_provider_mappings",
    {
      title: "List provider mappings",
      description: "List all environment→provider-resource mappings for a project.",
      inputSchema: { project: optionalNonEmptyString() },
    },
    guard((a: { project?: string }) => ({ status: "ok", mappings: svc.listProviderMappings(store, a.project) })),
  );

  server.registerTool(
    "get_provider_mapping",
    {
      title: "Get provider mapping",
      description: "Get the concrete provider resource mapped to a given environment.",
      inputSchema: { project: optionalNonEmptyString(), environment: nonEmptyString(), provider },
    },
    guard((a: { project?: string; environment: string; provider: (typeof PROVIDER_IDS)[number] }) => ({
      status: "ok",
      mapping: svc.getProviderMapping(store, a),
    })),
  );

  server.registerTool(
    "list_connections",
    {
      title: "List provider connections",
      description: "List configured provider connections. Secrets are never returned; only env var names are shown.",
      inputSchema: { provider: provider.optional() },
    },
    guard((a: { provider?: (typeof PROVIDER_IDS)[number] }) => ({ status: "ok", connections: svc.listConnections(store, a) })),
  );

  server.registerTool(
    "create_connection",
    {
      title: "Create provider connection",
      description:
        "Create an explicit provider connection backed by an environment variable. The secret value is never stored.",
      inputSchema: {
        provider,
        label: nonEmptyString("Friendly connection label"),
        envVar: nonEmptyString("Environment variable name holding the provider secret"),
        vercelTeamId: optionalNonEmptyString("Optional Vercel team id for this connection"),
      },
    },
    guard((a: { provider: (typeof PROVIDER_IDS)[number]; label: string; envVar: string; vercelTeamId?: string }) => ({
      status: "ok",
      connection: svc.createConnection(store, a),
    })),
  );

  // --- Policy --------------------------------------------------------------

  server.registerTool(
    "check_policy",
    {
      title: "Check policy",
      description:
        "Ask whether a capability (read/write/deploy/env_change/delete/destructive_sql/purchase) is " +
        "allowed, blocked, or requires approval for a provider in an environment — WITHOUT " +
        "executing anything.",
      inputSchema: {
        project: optionalNonEmptyString(),
        environment: nonEmptyString(),
        provider,
        capability,
        live: z.boolean().optional().describe("Treat as a live/irreversible action (e.g. Stripe live)"),
      },
    },
    guard((a: any) => ({ status: "ok", decision: svc.checkPolicy(store, a) })),
  );

  server.registerTool(
    "simulate_action",
    {
      title: "Simulate action",
      description:
        "Simulate a provider capability in an environment without executing a provider call or writing audit entries.",
      inputSchema: {
        project: optionalNonEmptyString(),
        environment: nonEmptyString(),
        provider,
        capability,
        live: z.boolean().optional(),
        resourceLabel: optionalNonEmptyString(),
      },
    },
    guard((a: any) => ({ status: "ok", decision: svc.simulateAction(store, a) })),
  );

  server.registerTool(
    "list_policy_rules",
    {
      title: "List policy rules",
      description: "List explicit policy rules (highest priority first). Built-in defaults also apply.",
      inputSchema: {},
    },
    guard(() => ({ status: "ok", rules: svc.listPolicyRules(store) })),
  );

  server.registerTool(
    "set_policy_rule",
    {
      title: "Set policy rule",
      description:
        "Add an explicit policy rule that overrides defaults. Higher priority wins. Use this to " +
        "approve something normally gated (effect:'allow') or to tighten further (effect:'block').",
      inputSchema: {
        effect: z.enum(["allow", "block", "approval_required"]),
        description: z.string().optional(),
        priority: nonNegativeInt("Default 100; higher wins").optional(),
        match: z
          .object({
            projectId: optionalNonEmptyString(),
            environmentId: optionalNonEmptyString(),
            environmentKind: z.enum(["development", "staging", "production"]).optional(),
            provider: provider.optional(),
            capability: capability.optional(),
          })
          .describe("Unset fields are wildcards"),
      },
    },
    guard((a: any) => ({ status: "ok", rule: svc.setPolicyRule(store, a) })),
  );

  server.registerTool(
    "list_pending_approvals",
    {
      title: "List pending approvals",
      description: "List approval requests created by gated provider actions.",
      inputSchema: {
        project: optionalNonEmptyString(),
        status: z.enum(["pending", "approved", "rejected", "used"]).optional(),
      },
    },
    guard((a: { project?: string; status?: "pending" | "approved" | "rejected" | "used" }) => ({
      status: "ok",
      approvals: svc.listPendingApprovals(store, a),
    })),
  );

  server.registerTool(
    "doctor",
    {
      title: "Doctor",
      description:
        "Run local readiness checks: project/environment resolution, mappings, credential env vars, and audit writability.",
      inputSchema: {
        project: optionalNonEmptyString("Project id or slug; uses selected if omitted"),
        environment: optionalNonEmptyString("Environment id or name to focus on"),
      },
    },
    guard((a: { project?: string; environment?: string }) => ({ status: "ok", report: svc.doctor(store, a) })),
  );

  server.registerTool(
    "approve_action",
    {
      title: "Approve action",
      description:
        "Approve a pending action request for one matching rerun. This never executes " +
        "the provider call by itself; rerun the original action after approval.",
      inputSchema: {
        approvalId: nonEmptyString("Approval id returned by an approval_required response"),
        note: optionalNonEmptyString("Optional human review note"),
      },
    },
    guard((a: { approvalId: string; note?: string }) => ({ status: "ok", ...svc.approveAction(store, a) })),
  );

  server.registerTool(
    "reject_action",
    {
      title: "Reject action",
      description: "Reject a pending action request so it cannot be approved later.",
      inputSchema: {
        approvalId: nonEmptyString("Approval id returned by an approval_required response"),
        note: optionalNonEmptyString("Optional rejection note"),
      },
    },
    guard((a: { approvalId: string; note?: string }) => ({ status: "ok", ...svc.rejectAction(store, a) })),
  );

  // --- Memory / audit ------------------------------------------------------

  server.registerTool(
    "read_project_memory",
    {
      title: "Read project memory",
      description: "Read short notes saved for a project (optionally scoped to one environment).",
      inputSchema: { project: optionalNonEmptyString(), environment: optionalNonEmptyString() },
    },
    guard((a: { project?: string; environment?: string }) => ({
      status: "ok",
      memory: svc.readProjectMemory(store, a),
    })),
  );

  server.registerTool(
    "write_project_memory",
    {
      title: "Write project memory",
      description:
        "Save a short note for a project/environment so future agent sessions know what happened " +
        "(e.g. 'Last Vercel deploy failed because DATABASE_URL was missing').",
      inputSchema: {
        project: optionalNonEmptyString(),
        environment: optionalNonEmptyString(),
        note: nonEmptyString(),
        tags: z.array(nonEmptyString()).optional(),
      },
    },
    guard((a: { project?: string; environment?: string; note: string; tags?: string[] }) => ({
      status: "ok",
      entry: svc.writeProjectMemory(store, a),
    })),
  );

  server.registerTool(
    "list_audit_log",
    {
      title: "List audit log",
      description: "List recent audit entries (every provider action is logged here). Filter by project, environment, provider.",
      inputSchema: {
        project: optionalNonEmptyString(),
        environment: optionalNonEmptyString(),
        provider: provider.optional(),
        limit: positiveInt().optional(),
      },
    },
    guard((a: { project?: string; environment?: string; provider?: (typeof PROVIDER_IDS)[number]; limit?: number }) => ({
      status: "ok",
      entries: svc.listAuditLog(store, a),
    })),
  );

  server.registerTool(
    "export_audit_log",
    {
      title: "Export audit log",
      description: "Export recent audit entries as jsonl, csv, or markdown.",
      inputSchema: {
        project: optionalNonEmptyString(),
        environment: optionalNonEmptyString(),
        provider: provider.optional(),
        limit: positiveInt().optional(),
        format: z.enum(["jsonl", "csv", "markdown"]),
      },
    },
    guard(
      (a: {
        project?: string;
        environment?: string;
        provider?: (typeof PROVIDER_IDS)[number];
        limit?: number;
        format: "jsonl" | "csv" | "markdown";
      }) => ({
        status: "ok",
        format: a.format,
        text: svc.exportAuditLog(store, a),
      }),
    ),
  );

  server.registerTool(
    "dashclaw_status",
    {
      title: "DashClaw status",
      description: "Check DashClaw authoritative gate configuration and reachability.",
      inputSchema: {},
    },
    guard(async () => ({ status: "ok", dashclaw: await svc.dashclawStatus() })),
  );

  server.registerTool(
    "dashclaw_recent_decisions",
    {
      title: "DashClaw recent decisions",
      description: "Read recent DashClaw guard decisions scoped to project/environment when supported by DashClaw.",
      inputSchema: {
        project: optionalNonEmptyString(),
        environment: optionalNonEmptyString(),
        limit: positiveInt().optional(),
      },
    },
    guard((a: { project?: string; environment?: string; limit?: number }) => svc.dashclawRecentDecisions(store, a)),
  );

  server.registerTool(
    "export_dashclaw_evidence",
    {
      title: "Export DashClaw evidence",
      description: "Export local audit entries that include DashClaw guard/evidence metadata.",
      inputSchema: {
        project: optionalNonEmptyString(),
        environment: optionalNonEmptyString(),
        provider: provider.optional(),
        limit: positiveInt().optional(),
      },
    },
    guard((a: { project?: string; environment?: string; provider?: (typeof PROVIDER_IDS)[number]; limit?: number }) => ({
      status: "ok",
      evidence: svc.exportDashclawEvidence(store, a),
    })),
  );

  server.registerTool(
    "explain_action_risk",
    {
      title: "Explain action risk",
      description: "Dry-run local policy and DashClaw guard context for a provider action without executing it.",
      inputSchema: {
        project: optionalNonEmptyString(),
        environment: nonEmptyString(),
        provider,
        capability,
        tool: nonEmptyString(),
        summary: nonEmptyString(),
        resourceLabel: optionalNonEmptyString(),
        live: z.boolean().optional(),
      },
    },
    guard((a: any) => svc.explainActionRisk(store, a)),
  );

  server.registerTool(
    "governed_action_summary",
    {
      title: "Governed action summary",
      description: "Summarize recent local audit entries with DashClaw correlation fields.",
      inputSchema: {
        project: optionalNonEmptyString(),
        environment: optionalNonEmptyString(),
        provider: provider.optional(),
        limit: positiveInt().optional(),
      },
    },
    guard((a: { project?: string; environment?: string; provider?: (typeof PROVIDER_IDS)[number]; limit?: number }) => ({
      status: "ok",
      summary: svc.governedActionSummary(store, a),
    })),
  );

  registerProviderTools(server, store);
}

function registerProviderTools(server: McpServer, store: Store): void {
  const env = nonEmptyString("Environment id or name");
  const proj = optionalNonEmptyString("Project id or slug; uses selected if omitted");

  // --- App logs ----------------------------------------------------------
  // Log reads are allowed by default in every environment (including
  // production); each read is policy-checked and written to the audit log.

  server.registerTool(
    "get_app_logs",
    {
      title: "Get app logs",
      description:
        "Fetch application/deployment logs for a project environment from the mapped provider(s). " +
        "If `provider` is given, reads that provider only; otherwise reads every mapped provider " +
        "that supports logs (Vercel + Railway in V0, Vercel prioritized). Returns the resource used, time range, log " +
        "lines, and any API limitation. Reads are allowed everywhere and are audited.",
      inputSchema: {
        project: proj,
        environment: env,
        provider: provider.optional().describe("Restrict to one provider (e.g. 'vercel')"),
        deployment_id: optionalNonEmptyString("Specific deployment to read logs for"),
        since: optionalNonEmptyString("Only logs after this time (epoch ms or ISO timestamp)"),
        limit: positiveInt("Max log lines (default 100)").optional(),
      },
    },
    guard((a: any) =>
      pa.appLogs(store, {
        project: a.project,
        environment: a.environment,
        provider: a.provider,
        deploymentId: a.deployment_id,
        since: a.since,
        limit: a.limit,
      }),
    ),
  );

  server.registerTool(
    "get_vercel_logs",
    {
      title: "Get Vercel logs",
      description:
        "Fetch logs from the mapped Vercel project. If `deployment_id` is given, reads that " +
        "deployment; otherwise resolves the latest deployment first. Returns the deployment " +
        "id/url/status plus log lines. Read-only and audited.",
      inputSchema: {
        project: proj,
        environment: env,
        deployment_id: optionalNonEmptyString("Deployment to read logs for; defaults to latest"),
        since: optionalNonEmptyString("Only logs after this time (epoch ms or ISO timestamp)"),
        limit: positiveInt("Max log lines (default 100)").optional(),
      },
    },
    guard((a: any) =>
      pa.vercelLogs(store, {
        project: a.project,
        environment: a.environment,
        deploymentId: a.deployment_id,
        since: a.since,
        limit: a.limit,
      }),
    ),
  );

  server.registerTool(
    "get_latest_deployment_logs",
    {
      title: "Get latest deployment logs",
      description:
        "Convenience: find the latest deployment for the mapped provider (default Vercel) and " +
        "fetch its logs. Returns deployment status + logs. Read-only and audited.",
      inputSchema: {
        project: proj,
        environment: env,
        provider: provider.optional().describe("Defaults to 'vercel'"),
      },
    },
    guard((a: any) =>
      pa.latestDeploymentLogs(store, {
        project: a.project,
        environment: a.environment,
        provider: a.provider,
      }),
    ),
  );

  // GitHub
  server.registerTool(
    "get_github_repo_context",
    {
      title: "GitHub repo context",
      description: "Read metadata (default branch, language, visibility, last push) for the mapped repo.",
      inputSchema: { project: proj, environment: env },
    },
    guard((a: any) => pa.githubRepoContext(store, a)),
  );
  server.registerTool(
    "get_github_repo_readme",
    {
      title: "GitHub README",
      description: "Fetch the README of the mapped repo.",
      inputSchema: { project: proj, environment: env },
    },
    guard((a: any) => pa.githubReadme(store, a)),
  );
  server.registerTool(
    "list_github_repo_files",
    {
      title: "List GitHub repo files",
      description: "List files/directories at a path in the mapped repo (default: root).",
      inputSchema: { project: proj, environment: env, path: z.string().optional() },
    },
    guard((a: any) => pa.githubListFiles(store, a)),
  );
  server.registerTool(
    "list_github_pull_requests",
    {
      title: "List GitHub pull requests",
      description: "List pull requests for the mapped repo.",
      inputSchema: {
        project: proj,
        environment: env,
        state: z.enum(["open", "closed", "all"]).optional(),
        limit: positiveInt().optional(),
      },
    },
    guard((a: any) => pa.githubPullRequests(store, a)),
  );
  server.registerTool(
    "list_github_branches",
    {
      title: "List GitHub branches",
      description: "List branches for the mapped repo.",
      inputSchema: { project: proj, environment: env, limit: positiveInt().optional() },
    },
    guard((a: any) => pa.githubBranches(store, a)),
  );
  server.registerTool(
    "get_github_status_checks",
    {
      title: "Get GitHub status checks",
      description: "Read the combined commit status for a branch, tag, or SHA in the mapped repo.",
      inputSchema: { project: proj, environment: env, ref: nonEmptyString("Branch, tag, or commit SHA") },
    },
    guard((a: any) => pa.githubStatusChecks(store, a)),
  );

  // Vercel
  server.registerTool(
    "get_vercel_project_context",
    {
      title: "Vercel project context",
      description: "Read the mapped Vercel project (framework, id).",
      inputSchema: { project: proj, environment: env },
    },
    guard((a: any) => pa.vercelProjectContext(store, a)),
  );
  server.registerTool(
    "get_vercel_deployments",
    {
      title: "Vercel deployments",
      description: "List recent deployments for the mapped Vercel project.",
      inputSchema: { project: proj, environment: env, limit: positiveInt().optional() },
    },
    guard((a: any) => pa.vercelDeployments(store, a)),
  );
  server.registerTool(
    "get_vercel_deployment_status",
    {
      title: "Vercel deployment status",
      description: "Get the readyState/status of a specific deployment.",
      inputSchema: { project: proj, environment: env, deploymentId: nonEmptyString() },
    },
    guard((a: any) => pa.vercelDeploymentStatus(store, a)),
  );
  server.registerTool(
    "get_vercel_deployment_logs",
    {
      title: "Vercel deployment logs",
      description: "Fetch build/runtime events (logs) for a specific deployment.",
      inputSchema: { project: proj, environment: env, deploymentId: nonEmptyString(), limit: positiveInt().optional() },
    },
    guard((a: any) => pa.vercelDeploymentLogs(store, a)),
  );
  server.registerTool(
    "set_vercel_env_var",
    {
      title: "Set Vercel env var",
      description:
        "Set/upsert an environment variable on the mapped Vercel project. PRODUCTION changes " +
        "require approval by default.",
      inputSchema: {
        project: proj,
        environment: env,
        key: nonEmptyString(),
        value: z.string(),
        target: z.array(nonEmptyString()).optional().describe("e.g. ['production'] or ['preview']"),
      },
    },
    guard((a: any) => pa.vercelSetEnvVar(store, a)),
  );
  server.registerTool(
    "create_vercel_project",
    {
      title: "Create Vercel project",
      description:
        "Create a new Vercel project (optionally with a framework preset). Map it afterwards with " +
        "map_provider_resource so deploys and env vars target it.",
      inputSchema: {
        project: proj,
        environment: env,
        name: nonEmptyString("Vercel project name, e.g. acme-site"),
        framework: optionalNonEmptyString("Framework preset, e.g. nextjs, vite, astro"),
      },
    },
    guard((a: any) => pa.vercelCreateProject(store, a)),
  );
  server.registerTool(
    "add_vercel_domain",
    {
      title: "Add Vercel domain",
      description:
        "Attach a domain to a Vercel project. The result includes the DNS record to create at the " +
        "registrar (A 76.76.21.21 for apex, CNAME cname.vercel-dns.com for subdomains) and any " +
        "verification challenges — set them with set_dns_records.",
      inputSchema: {
        project: proj,
        environment: env,
        vercel_project: nonEmptyString("Vercel project id or name"),
        domain: nonEmptyString("Domain to attach, e.g. example.com or www.example.com"),
      },
    },
    guard((a: any) =>
      pa.vercelAddDomain(store, {
        project: a.project,
        environment: a.environment,
        vercelProject: a.vercel_project,
        domain: a.domain,
      }),
    ),
  );
  server.registerTool(
    "create_vercel_deployment",
    {
      title: "Create Vercel deployment",
      description: "Trigger a deployment of the mapped Vercel project. PRODUCTION deploys require approval by default.",
      inputSchema: {
        project: proj,
        environment: env,
        name: optionalNonEmptyString(),
        deploymentId: optionalNonEmptyString("Redeploy from an existing deployment id"),
        gitSource: z
          .object({
            type: z.literal("github"),
            repoId: nonEmptyString("GitHub repo id"),
            ref: optionalNonEmptyString("Git ref"),
            sha: optionalNonEmptyString("Commit SHA"),
          })
          .optional(),
      },
    },
    guard((a: any) => pa.vercelCreateDeployment(store, a)),
  );

  // Railway (GraphQL API)
  server.registerTool(
    "get_railway_project_context",
    {
      title: "Railway project context",
      description: "Read the mapped Railway project: its name, environments, and services.",
      inputSchema: { project: proj, environment: env },
    },
    guard((a: any) => pa.railwayProjectContext(store, a)),
  );
  server.registerTool(
    "discover_railway_resources",
    {
      title: "Discover Railway resources",
      description: "List Railway projects with their environment and service ids so they can be mapped.",
      inputSchema: { project: proj, environment: env },
    },
    guard((a: any) => pa.railwayDiscover(store, a)),
  );
  server.registerTool(
    "get_railway_deployments",
    {
      title: "Railway deployments",
      description: "List recent deployments for the mapped Railway project (scoped to its environment/service if mapped).",
      inputSchema: { project: proj, environment: env, limit: positiveInt().optional() },
    },
    guard((a: any) => pa.railwayDeployments(store, a)),
  );
  server.registerTool(
    "get_railway_logs",
    {
      title: "Get Railway logs",
      description:
        "Fetch logs from the mapped Railway project. If `deployment_id` is given, reads that " +
        "deployment; otherwise resolves the latest deployment first. Returns the deployment " +
        "id/url/status plus log lines. Read-only and audited.",
      inputSchema: {
        project: proj,
        environment: env,
        deployment_id: optionalNonEmptyString("Deployment to read logs for; defaults to latest"),
        since: optionalNonEmptyString("Only logs after this time (ISO timestamp)"),
        limit: positiveInt("Max log lines (default 100)").optional(),
      },
    },
    guard((a: any) =>
      pa.railwayLogs(store, {
        project: a.project,
        environment: a.environment,
        deploymentId: a.deployment_id,
        since: a.since,
        limit: a.limit,
      }),
    ),
  );
  server.registerTool(
    "create_railway_deployment",
    {
      title: "Create Railway deployment",
      description:
        "Trigger a deployment of the mapped Railway service, or redeploy an existing deployment " +
        "(pass deployment_id). PRODUCTION deploys require approval by default.",
      inputSchema: {
        project: proj,
        environment: env,
        deployment_id: optionalNonEmptyString("Redeploy this existing deployment instead of triggering a fresh one"),
      },
    },
    guard((a: any) =>
      pa.railwayCreateDeployment(store, {
        project: a.project,
        environment: a.environment,
        deploymentId: a.deployment_id,
      }),
    ),
  );
  server.registerTool(
    "set_railway_env_var",
    {
      title: "Set Railway variable",
      description:
        "Create/update a variable on the mapped Railway project/service. PRODUCTION changes " +
        "require approval by default. Railway redeploys the affected service unless skip_deploys is true.",
      inputSchema: {
        project: proj,
        environment: env,
        key: nonEmptyString(),
        value: z.string(),
        service_id: optionalNonEmptyString("Override the mapped serviceId (omit for a shared variable)"),
        skip_deploys: z.boolean().optional().describe("Don't trigger a redeploy after the change"),
      },
    },
    guard((a: any) =>
      pa.railwaySetEnvVar(store, {
        project: a.project,
        environment: a.environment,
        key: a.key,
        value: a.value,
        serviceId: a.service_id,
        skipDeploys: a.skip_deploys,
      }),
    ),
  );

  // Namecheap
  server.registerTool(
    "check_domain_availability",
    {
      title: "Check domain availability",
      description:
        "Check whether domains are available to register, including premium status and pricing. Read-only.",
      inputSchema: {
        project: proj,
        environment: env,
        domains: z.array(nonEmptyString()).min(1).describe("Domain names to check, e.g. [\"example.com\"]"),
      },
    },
    guard((a: any) => pa.checkDomainAvailability(store, a)),
  );
  server.registerTool(
    "list_namecheap_domains",
    {
      title: "List Namecheap domains",
      description: "List domains in the Namecheap account with expiry and lock status. Read-only.",
      inputSchema: {
        project: proj,
        environment: env,
        page: positiveInt("Page number (default 1)").optional(),
        page_size: positiveInt("Domains per page (10-100, default 20)").optional(),
        search_term: optionalNonEmptyString("Keyword filter"),
      },
    },
    guard((a: any) =>
      pa.namecheapListDomains(store, {
        project: a.project,
        environment: a.environment,
        page: a.page,
        pageSize: a.page_size,
        searchTerm: a.search_term,
      }),
    ),
  );
  server.registerTool(
    "purchase_domain",
    {
      title: "Purchase domain",
      description:
        "Register a domain via Namecheap. SPENDS REAL MONEY and ALWAYS requires human approval " +
        "(capability \"purchase\" cannot be policy-allowed). Uses the namecheap.registrant contact " +
        "from .offlocal/config.yaml. Set NAMECHEAP_SANDBOX=true to test without real charges.",
      inputSchema: {
        project: proj,
        environment: env,
        domain: nonEmptyString("Domain to register, e.g. example.com"),
        years: positiveInt("Registration years (default 1)").optional(),
      },
    },
    guard((a: any) => pa.purchaseDomain(store, a)),
  );
  server.registerTool(
    "get_dns_records",
    {
      title: "Get DNS records",
      description: "List the DNS host records Namecheap serves for a domain. Read-only.",
      inputSchema: { project: proj, environment: env, domain: nonEmptyString("Domain, e.g. example.com") },
    },
    guard((a: any) => pa.getDnsRecords(store, a)),
  );
  server.registerTool(
    "set_dns_records",
    {
      title: "Set DNS records",
      description:
        "Set the DNS host records for a domain. WARNING: this REPLACES ALL existing host records " +
        "for the domain — include every record you want to keep (use get_dns_records first). " +
        "Approval required in production by default.",
      inputSchema: {
        project: proj,
        environment: env,
        domain: nonEmptyString("Domain, e.g. example.com"),
        records: z
          .array(
            z.object({
              name: nonEmptyString("Host name, e.g. @ or www"),
              type: nonEmptyString("Record type: A, AAAA, CNAME, MX, TXT, URL, ..."),
              address: nonEmptyString("Record value (IP, hostname, or text)"),
              ttl: positiveInt("TTL seconds (60-60000, default 1800)").optional(),
              mx_pref: positiveInt("MX preference (MX records only)").optional(),
            }),
          )
          .min(1)
          .describe("The COMPLETE set of host records for the domain"),
      },
    },
    guard((a: any) =>
      pa.setDnsRecords(store, {
        project: a.project,
        environment: a.environment,
        domain: a.domain,
        records: (a.records ?? []).map((r: any) => ({
          name: r.name,
          type: r.type,
          address: r.address,
          ttl: r.ttl,
          mxPref: r.mx_pref,
        })),
      }),
    ),
  );

  // Neon
  server.registerTool(
    "list_neon_projects",
    {
      title: "List Neon projects",
      description: "List all Neon projects visible to the API key (account-level, read-only).",
      inputSchema: { project: proj, environment: env },
    },
    guard((a: any) => pa.neonListProjects(store, a)),
  );
  server.registerTool(
    "create_neon_project",
    {
      title: "Create Neon project",
      description:
        "Provision a new Neon Postgres project. The result includes the connection URI for the " +
        "default branch — store it as an env var (e.g. DATABASE_URL); it never appears in the audit log.",
      inputSchema: {
        project: proj,
        environment: env,
        name: optionalNonEmptyString("Project name (Neon generates one if omitted)"),
        region_id: optionalNonEmptyString("Neon region, e.g. aws-us-east-1"),
        pg_version: positiveInt("Postgres major version, e.g. 17").optional(),
      },
    },
    guard((a: any) =>
      pa.neonCreateProject(store, {
        project: a.project,
        environment: a.environment,
        name: a.name,
        regionId: a.region_id,
        pgVersion: a.pg_version,
      }),
    ),
  );
  server.registerTool(
    "get_neon_connection_uri",
    {
      title: "Get Neon connection URI",
      description:
        "Fetch the connection URI (DATABASE_URL) for a Neon project/branch/database/role. The URI " +
        "contains credentials: it is returned to you only and is redacted from audit + DashClaw.",
      inputSchema: {
        project: proj,
        environment: env,
        neon_project_id: nonEmptyString("Neon project id"),
        database_name: nonEmptyString("Database name, e.g. neondb"),
        role_name: nonEmptyString("Role name, e.g. neondb_owner"),
        branch_id: optionalNonEmptyString("Branch id (defaults to the project's default branch)"),
        pooled: z.boolean().optional().describe("Return the pooled connection URI"),
      },
    },
    guard((a: any) =>
      pa.neonGetConnectionUri(store, {
        project: a.project,
        environment: a.environment,
        neonProjectId: a.neon_project_id,
        databaseName: a.database_name,
        roleName: a.role_name,
        branchId: a.branch_id,
        pooled: a.pooled,
      }),
    ),
  );

  // Supabase
  server.registerTool(
    "list_supabase_projects",
    {
      title: "List Supabase projects",
      description: "List all Supabase projects visible to the access token (account-level, read-only).",
      inputSchema: { project: proj, environment: env },
    },
    guard((a: any) => pa.supabaseListProjects(store, a)),
  );
  server.registerTool(
    "get_supabase_project_context",
    {
      title: "Supabase project context",
      description: "Get details of the mapped Supabase project (status, region).",
      inputSchema: { project: proj, environment: env },
    },
    guard((a: any) => pa.supabaseProjectContext(store, a)),
  );
  server.registerTool(
    "query_supabase",
    {
      title: "Query Supabase",
      description:
        "Run SQL against the mapped Supabase project. Reads run with read_only=true. Destructive SQL " +
        "(DROP/TRUNCATE/DELETE/ALTER…) is blocked everywhere by default; non-read writes in production " +
        "require approval.",
      inputSchema: { project: proj, environment: env, sql: nonEmptyString() },
    },
    guard((a: any) => pa.supabaseQuery(store, a)),
  );
  server.registerTool(
    "get_supabase_logs",
    {
      title: "Get Supabase logs",
      description: "Read project logs from the mapped Supabase project. Availability depends on Supabase plan/API limits.",
      inputSchema: {
        project: proj,
        environment: env,
        service: optionalNonEmptyString("Optional service/log source"),
        since: optionalNonEmptyString("Optional timestamp filter"),
        limit: positiveInt().optional(),
      },
    },
    guard((a: any) => pa.supabaseLogs(store, a)),
  );
  server.registerTool(
    "apply_supabase_migration",
    {
      title: "Apply Supabase migration",
      description:
        "Apply SQL through the Supabase migrations endpoint. Production writes require approval and endpoint access may be restricted by Supabase.",
      inputSchema: { project: proj, environment: env, name: nonEmptyString(), sql: nonEmptyString() },
    },
    guard((a: any) => pa.supabaseApplyMigration(store, a)),
  );

  // Stripe
  server.registerTool(
    "list_stripe_products",
    {
      title: "List Stripe products",
      description: "List products in the environment's Stripe mode (test/live).",
      inputSchema: { project: proj, environment: env, limit: positiveInt().optional() },
    },
    guard((a: any) => pa.stripeListProducts(store, a)),
  );
  server.registerTool(
    "list_stripe_customers",
    {
      title: "List Stripe customers",
      description: "List customers in the environment's Stripe mode (test/live).",
      inputSchema: { project: proj, environment: env, limit: positiveInt().optional() },
    },
    guard((a: any) => pa.stripeListCustomers(store, a)),
  );
  server.registerTool(
    "list_stripe_subscriptions",
    {
      title: "List Stripe subscriptions",
      description: "List subscriptions in the environment's Stripe mode (test/live).",
      inputSchema: { project: proj, environment: env, limit: positiveInt().optional(), status: optionalNonEmptyString() },
    },
    guard((a: any) => pa.stripeListSubscriptions(store, a)),
  );
  server.registerTool(
    "list_stripe_invoices",
    {
      title: "List Stripe invoices",
      description: "List invoices in the environment's Stripe mode (test/live).",
      inputSchema: {
        project: proj,
        environment: env,
        limit: positiveInt().optional(),
        customer: optionalNonEmptyString("Optional Stripe customer id"),
      },
    },
    guard((a: any) => pa.stripeListInvoices(store, a)),
  );
  server.registerTool(
    "create_stripe_webhook",
    {
      title: "Create Stripe webhook",
      description:
        "Create a webhook endpoint in the environment's Stripe mode. The result includes the whsec_ " +
        "signing secret which Stripe shows ONLY ONCE — store it as an env var immediately " +
        "(e.g. set_vercel_env_var STRIPE_WEBHOOK_SECRET). It never appears in the audit log. " +
        "LIVE-mode writes require approval.",
      inputSchema: {
        project: proj,
        environment: env,
        url: nonEmptyString("HTTPS endpoint URL Stripe should call"),
        enabled_events: z
          .array(nonEmptyString())
          .min(1)
          .describe('Stripe event names, e.g. ["checkout.session.completed", "invoice.paid"]'),
        description: z.string().optional(),
      },
    },
    guard((a: any) =>
      pa.stripeCreateWebhook(store, {
        project: a.project,
        environment: a.environment,
        url: a.url,
        enabledEvents: a.enabled_events,
        description: a.description,
      }),
    ),
  );
  server.registerTool(
    "list_stripe_webhooks",
    {
      title: "List Stripe webhooks",
      description:
        "List webhook endpoints in the environment's Stripe mode (signing secrets are never returned by list).",
      inputSchema: { project: proj, environment: env, limit: positiveInt().optional() },
    },
    guard((a: any) => pa.stripeListWebhooks(store, a)),
  );
  server.registerTool(
    "create_stripe_product",
    {
      title: "Create Stripe product",
      description:
        "Create a product. Test-mode writes are allowed by default; LIVE-mode writes require approval.",
      inputSchema: { project: proj, environment: env, name: nonEmptyString(), description: z.string().optional() },
    },
    guard((a: any) => pa.stripeCreateProduct(store, a)),
  );
  server.registerTool(
    "create_stripe_price",
    {
      title: "Create Stripe price",
      description:
        "Create a price for a product. Test-mode writes allowed by default; LIVE-mode writes require approval.",
      inputSchema: {
        project: proj,
        environment: env,
        product: nonEmptyString("Stripe product id"),
        currency: nonEmptyString("ISO currency, e.g. 'usd'"),
        unitAmount: positiveInt("Amount in the smallest currency unit, e.g. cents"),
        recurringInterval: z.enum(["day", "week", "month", "year"]).optional(),
      },
    },
    guard((a: any) => pa.stripeCreatePrice(store, a)),
  );
}
