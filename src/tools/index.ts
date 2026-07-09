import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Store } from "../storage.js";
import * as svc from "../service.js";
import * as pa from "../provider-actions.js";
import * as dep from "../deploy.js";
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

const provider = z.enum(["github", "vercel", "supabase", "stripe", "railway", "render"]);
const deployProvider = z.enum(["vercel", "railway", "render"]);
const capability = z.enum(["read", "write", "deploy", "env_change", "delete", "destructive_sql"]);

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
        name: z.string().describe("Display name, e.g. 'Your Project'"),
        slug: z.string().optional().describe("Optional id-safe slug; derived from name if omitted"),
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
      inputSchema: { project: z.string().describe("Project id or slug") },
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
        project: z.string().optional().describe("Project id or slug; uses selected if omitted"),
        environment: z.string().optional().describe("Environment id or name to focus on (e.g. 'staging')"),
      },
    },
    guard(async (a: { project?: string; environment?: string }) => ({
      status: "ok",
      context: await svc.getProjectContext(store, a.project, a.environment),
    })),
  );

  server.registerTool(
    "add_environment",
    {
      title: "Add environment",
      description: "Add an environment (e.g. staging, production) to a project.",
      inputSchema: {
        project: z.string().optional(),
        name: z.string().describe("e.g. 'staging' or 'production'"),
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
      inputSchema: { project: z.string().optional() },
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
        "{provider:'supabase',projectRef:'your_project_ref'}, {provider:'stripe',mode:'live'}, " +
        "{provider:'railway',projectId:'...',environmentId:'...',serviceId:'...'}. " +
        "Pass `connection` (a label/id from add_provider_connection) to use a specific account " +
        "when you have more than one for this provider.",
      inputSchema: {
        project: z.string().optional(),
        environment: z.string().describe("Environment id or name"),
        provider,
        resource: z
          .record(z.any())
          .describe("Resource object including a 'provider' field matching `provider`"),
        connection: z
          .string()
          .optional()
          .describe("Named connection (label or id) to use; defaults to the provider's default connection"),
      },
    },
    guard((a: { project?: string; environment: string; provider: (typeof PROVIDER_IDS)[number]; resource: any; connection?: string }) => {
      const res = svc.mapProviderResource(store, {
        project: a.project,
        environment: a.environment,
        provider: a.provider,
        resource: { provider: a.provider, ...a.resource },
        connection: a.connection,
      });
      return { status: "ok", project: res.project.slug, environment: res.environment.name, mappingId: res.mappingId };
    }),
  );

  server.registerTool(
    "add_provider_connection",
    {
      title: "Add provider connection",
      description:
        "Register a named provider account that reads its token from its own environment variable — " +
        "the basis for multi-account orchestration. Set the env var in your MCP client config, then " +
        "bind environments to this connection via map_provider_resource's `connection` arg. Example: " +
        "{provider:'vercel', label:'client-a', envVar:'VERCEL_TOKEN_CLIENT_A'}. Tokens are never persisted.",
      inputSchema: {
        provider,
        label: z.string().describe("Friendly unique name for this account, e.g. 'client-a'"),
        envVar: z
          .string()
          .optional()
          .describe("Env var holding this account's token (defaults to the provider's standard var)"),
        vercelTeamId: z.string().optional().describe("Vercel only: default team id for this account"),
      },
    },
    guard((a: { provider: (typeof PROVIDER_IDS)[number]; label: string; envVar?: string; vercelTeamId?: string }) => ({
      status: "ok",
      connection: svc.addConnection(store, a),
    })),
  );

  server.registerTool(
    "list_provider_connections",
    {
      title: "List provider connections",
      description:
        "List configured provider connections (accounts) and whether each one's env var is currently " +
        "set. Token values are never shown.",
      inputSchema: {},
    },
    guard(() => ({ status: "ok", connections: svc.listConnections(store) })),
  );

  server.registerTool(
    "list_provider_mappings",
    {
      title: "List provider mappings",
      description: "List all environment→provider-resource mappings for a project.",
      inputSchema: { project: z.string().optional() },
    },
    guard((a: { project?: string }) => ({ status: "ok", mappings: svc.listProviderMappings(store, a.project) })),
  );

  server.registerTool(
    "get_provider_mapping",
    {
      title: "Get provider mapping",
      description: "Get the concrete provider resource mapped to a given environment.",
      inputSchema: { project: z.string().optional(), environment: z.string(), provider },
    },
    guard((a: { project?: string; environment: string; provider: (typeof PROVIDER_IDS)[number] }) => ({
      status: "ok",
      mapping: svc.getProviderMapping(store, a),
    })),
  );

  // --- Policy --------------------------------------------------------------

  server.registerTool(
    "check_policy",
    {
      title: "Check policy",
      description:
        "Ask whether a capability (read/write/deploy/env_change/delete/destructive_sql) is " +
        "allowed, blocked, or requires approval for a provider in an environment — WITHOUT " +
        "executing anything.",
      inputSchema: {
        project: z.string().optional(),
        environment: z.string(),
        provider,
        capability,
        live: z.boolean().optional().describe("Treat as a live/irreversible action (e.g. Stripe live)"),
      },
    },
    guard((a: any) => ({ status: "ok", decision: svc.checkPolicy(store, a) })),
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
        priority: z.number().optional().describe("Default 100; higher wins"),
        match: z
          .object({
            projectId: z.string().optional(),
            environmentId: z.string().optional(),
            environmentKind: z.enum(["development", "staging", "production"]).optional(),
            provider: provider.optional(),
            capability: capability.optional(),
          })
          .describe("Unset fields are wildcards"),
      },
    },
    guard((a: any) => ({ status: "ok", rule: svc.setPolicyRule(store, a) })),
  );

  // --- Memory / audit ------------------------------------------------------

  server.registerTool(
    "read_project_memory",
    {
      title: "Read project memory",
      description: "Read short notes saved for a project (optionally scoped to one environment).",
      inputSchema: { project: z.string().optional(), environment: z.string().optional() },
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
        project: z.string().optional(),
        environment: z.string().optional(),
        note: z.string(),
        tags: z.array(z.string()).optional(),
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
        project: z.string().optional(),
        environment: z.string().optional(),
        provider: provider.optional(),
        limit: z.number().optional(),
      },
    },
    guard((a: { project?: string; environment?: string; provider?: (typeof PROVIDER_IDS)[number]; limit?: number }) => ({
      status: "ok",
      entries: svc.listAuditLog(store, a),
    })),
  );

  registerProviderTools(server, store);
}

function registerProviderTools(server: McpServer, store: Store): void {
  const env = z.string().describe("Environment id or name");
  const proj = z.string().optional().describe("Project id or slug; uses selected if omitted");

  // --- Deploy (the one interface) ----------------------------------------
  // One tool to ship. It picks the mapped deploy provider, triggers the deploy
  // through the normal guarded flow (so production still asks for approval and
  // everything is audited), waits for it to finish, and returns the live URL —
  // or, on failure, a tail of the logs.

  server.registerTool(
    "deploy",
    {
      title: "Deploy",
      description:
        "Ship a project environment. THE deploy tool — say the project and environment and offlocal " +
        "figures out the rest: it finds the mapped deploy target (Vercel, Railway, or Render), triggers " +
        "the deployment, waits for it to finish, and returns the live URL. On failure it returns a tail " +
        "of the build logs so you can fix and redeploy. Non-production deploys just run; production " +
        "deploys return 'approval_required' until approved. Pass `provider` only if an environment has " +
        "more than one deploy target.",
      inputSchema: {
        project: proj,
        environment: env,
        provider: deployProvider.optional().describe("Only needed when >1 deploy target is mapped to the environment"),
        wait: z.boolean().optional().describe("Wait for the deploy to finish (default true); false returns as soon as it's triggered"),
        timeout_seconds: z.number().optional().describe("Max seconds to wait for a terminal state (default 180)"),
        commit_id: z.string().optional().describe("Vercel/Render: deploy a specific git commit"),
        deployment_id: z.string().optional().describe("Vercel: redeploy an existing deployment by id"),
      },
    },
    guard((a: any) =>
      dep.deploy(store, {
        project: a.project,
        environment: a.environment,
        provider: a.provider,
        wait: a.wait,
        timeoutSeconds: a.timeout_seconds,
        commitId: a.commit_id,
        deploymentId: a.deployment_id,
      }),
    ),
  );

  server.registerTool(
    "get_deploy_status",
    {
      title: "Get deploy status",
      description:
        "Check the current status and URL of a deployment WITHOUT triggering a new one. Useful after a " +
        "`deploy` with wait:false, or to poll a long build. Returns deployed / failed / deploying plus the " +
        "live URL when ready.",
      inputSchema: {
        project: proj,
        environment: env,
        provider: deployProvider.optional().describe("Only needed when >1 deploy target is mapped"),
        deployment_id: z.string().describe("The deployment/deploy id to check"),
      },
    },
    guard((a: any) =>
      dep.deployStatus(store, {
        project: a.project,
        environment: a.environment,
        provider: a.provider,
        deploymentId: a.deployment_id,
      }),
    ),
  );

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
        deployment_id: z.string().optional().describe("Specific deployment to read logs for"),
        since: z.string().optional().describe("Only logs after this time (epoch ms or ISO timestamp)"),
        limit: z.number().optional().describe("Max log lines (default 100)"),
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
        deployment_id: z.string().optional().describe("Deployment to read logs for; defaults to latest"),
        since: z.string().optional().describe("Only logs after this time (epoch ms or ISO timestamp)"),
        limit: z.number().optional().describe("Max log lines (default 100)"),
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
      inputSchema: { project: proj, environment: env, limit: z.number().optional() },
    },
    guard((a: any) => pa.vercelDeployments(store, a)),
  );
  server.registerTool(
    "get_vercel_deployment_status",
    {
      title: "Vercel deployment status",
      description: "Get the readyState/status of a specific deployment.",
      inputSchema: { project: proj, environment: env, deploymentId: z.string() },
    },
    guard((a: any) => pa.vercelDeploymentStatus(store, a)),
  );
  server.registerTool(
    "get_vercel_deployment_logs",
    {
      title: "Vercel deployment logs",
      description: "Fetch build/runtime events (logs) for a specific deployment.",
      inputSchema: { project: proj, environment: env, deploymentId: z.string(), limit: z.number().optional() },
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
        key: z.string(),
        value: z.string(),
        target: z.array(z.string()).optional().describe("e.g. ['production'] or ['preview']"),
      },
    },
    guard((a: any) => pa.vercelSetEnvVar(store, a)),
  );
  server.registerTool(
    "create_vercel_deployment",
    {
      title: "Create Vercel deployment",
      description: "Trigger a deployment of the mapped Vercel project. PRODUCTION deploys require approval by default.",
      inputSchema: {
        project: proj,
        environment: env,
        name: z.string().optional(),
        deploymentId: z.string().optional().describe("Redeploy from an existing deployment id"),
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
    "get_railway_deployments",
    {
      title: "Railway deployments",
      description: "List recent deployments for the mapped Railway project (scoped to its environment/service if mapped).",
      inputSchema: { project: proj, environment: env, limit: z.number().optional() },
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
        deployment_id: z.string().optional().describe("Deployment to read logs for; defaults to latest"),
        since: z.string().optional().describe("Only logs after this time (ISO timestamp)"),
        limit: z.number().optional().describe("Max log lines (default 100)"),
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
        deployment_id: z.string().optional().describe("Redeploy this existing deployment instead of triggering a fresh one"),
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
        key: z.string(),
        value: z.string(),
        service_id: z.string().optional().describe("Override the mapped serviceId (omit for a shared variable)"),
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

  // Render (REST API)
  server.registerTool(
    "get_render_service_context",
    {
      title: "Render service context",
      description: "Read the mapped Render service: type, public URL, repo/branch, and suspended state.",
      inputSchema: { project: proj, environment: env },
    },
    guard((a: any) => pa.renderServiceContext(store, a)),
  );
  server.registerTool(
    "get_render_deployments",
    {
      title: "Render deploys",
      description: "List recent deploys for the mapped Render service (newest first).",
      inputSchema: { project: proj, environment: env, limit: z.number().optional() },
    },
    guard((a: any) => pa.renderDeployments(store, a)),
  );
  server.registerTool(
    "get_render_logs",
    {
      title: "Get Render logs",
      description:
        "Fetch logs for the mapped Render service. Returns the latest deploy id/status plus recent log " +
        "lines (Render's logs are service-scoped). Read-only and audited.",
      inputSchema: {
        project: proj,
        environment: env,
        deployment_id: z.string().optional().describe("Deploy whose status to report; logs are the service's recent logs"),
        since: z.string().optional().describe("Only logs after this time (ISO timestamp)"),
        limit: z.number().optional().describe("Max log lines (default 100)"),
      },
    },
    guard((a: any) =>
      pa.renderLogs(store, {
        project: a.project,
        environment: a.environment,
        deploymentId: a.deployment_id,
        since: a.since,
        limit: a.limit,
      }),
    ),
  );
  server.registerTool(
    "create_render_deployment",
    {
      title: "Create Render deployment",
      description:
        "Trigger a deploy of the mapped Render service. PRODUCTION deploys require approval by default. " +
        "Prefer the `deploy` tool, which waits and returns the live URL.",
      inputSchema: {
        project: proj,
        environment: env,
        commit_id: z.string().optional().describe("Deploy a specific git commit"),
        clear_cache: z.boolean().optional().describe("Clear the build cache before deploying"),
      },
    },
    guard((a: any) =>
      pa.renderCreateDeployment(store, {
        project: a.project,
        environment: a.environment,
        commitId: a.commit_id,
        clearCache: a.clear_cache,
      }),
    ),
  );
  server.registerTool(
    "set_render_env_var",
    {
      title: "Set Render env var",
      description:
        "Create/update an environment variable on the mapped Render service. PRODUCTION changes require " +
        "approval by default. Render redeploys the service on change.",
      inputSchema: { project: proj, environment: env, key: z.string(), value: z.string() },
    },
    guard((a: any) => pa.renderSetEnvVar(store, a)),
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
      inputSchema: { project: proj, environment: env, sql: z.string() },
    },
    guard((a: any) => pa.supabaseQuery(store, a)),
  );

  // Stripe
  server.registerTool(
    "list_stripe_products",
    {
      title: "List Stripe products",
      description: "List products in the environment's Stripe mode (test/live).",
      inputSchema: { project: proj, environment: env, limit: z.number().optional() },
    },
    guard((a: any) => pa.stripeListProducts(store, a)),
  );
  server.registerTool(
    "create_stripe_product",
    {
      title: "Create Stripe product",
      description:
        "Create a product. Test-mode writes are allowed by default; LIVE-mode writes require approval.",
      inputSchema: { project: proj, environment: env, name: z.string(), description: z.string().optional() },
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
        product: z.string().describe("Stripe product id"),
        currency: z.string().describe("ISO currency, e.g. 'usd'"),
        unitAmount: z.number().describe("Amount in the smallest currency unit, e.g. cents"),
        recurringInterval: z.enum(["day", "week", "month", "year"]).optional(),
      },
    },
    guard((a: any) => pa.stripeCreatePrice(store, a)),
  );
}
