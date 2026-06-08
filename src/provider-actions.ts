import type { Store } from "./storage.js";
import { runGuarded, type GuardedResponse } from "./actions.js";
import {
  resolveProject,
  resolveEnvironment,
  requireMapping,
  findMapping,
} from "./resolve.js";
import { classifySql } from "./sql.js";
import { resolveStripeKey } from "./providers/auth.js";
import * as gh from "./providers/github.js";
import * as vc from "./providers/vercel.js";
import * as sb from "./providers/supabase.js";
import * as st from "./providers/stripe.js";
import type { ActionContext, Capability, Environment, Project, ProviderId } from "./types.js";
import { findConnection } from "./resolve.js";
import { resolveToken } from "./providers/auth.js";
import { defaultEnvVar } from "./providers/auth.js";
import { OfflocalError } from "./util.js";

/**
 * Provider actions. Every function:
 *   1. resolves project + environment,
 *   2. resolves the provider mapping (concrete resource) + credentials,
 *   3. builds an ActionContext and runs it through runGuarded,
 *      which enforces policy and writes the audit log.
 * The real provider call only runs inside the `exec` thunk when policy allows.
 */

interface Base {
  project?: string;
  environment: string;
}

function resolve(store: Store, input: Base): { project: Project; environment: Environment } {
  const project = resolveProject(store, input.project);
  const environment = resolveEnvironment(store, project, input.environment);
  return { project, environment };
}

function tokenFor(store: Store, provider: ProviderId): string {
  const conn = findConnection(store, provider);
  if (conn) return resolveToken(conn);
  const envVar = defaultEnvVar(provider);
  const v = process.env[envVar];
  if (!v || v.trim().length === 0) {
    throw new OfflocalError(
      `No ${provider} connection and ${envVar} is not set. Configure credentials first.`,
    );
  }
  return v.trim();
}

function vercelTeamId(store: Store, mappingTeamId?: string): string | undefined {
  if (mappingTeamId) return mappingTeamId;
  const conn = store.data.connections.find((c) => c.provider === "vercel");
  return conn?.scope?.vercelTeamId ?? process.env.VERCEL_TEAM_ID;
}

function ctx(
  project: Project,
  environment: Environment,
  provider: ProviderId,
  capability: Capability,
  tool: string,
  summary: string,
  extra?: { live?: boolean; resourceLabel?: string },
): ActionContext {
  return { project, environment, provider, capability, tool, summary, ...extra };
}

// --- GitHub ----------------------------------------------------------------

export async function githubRepoContext(store: Store, input: Base): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const m = requireMapping(store, project, environment, "github");
  const r = m.resource as { owner: string; repo: string };
  const label = `${r.owner}/${r.repo}`;
  return runGuarded(
    store,
    ctx(project, environment, "github", "read", "get_github_repo_context", `repo ${label}`, {
      resourceLabel: label,
    }),
    () => gh.getRepoContext(tokenFor(store, "github"), r.owner, r.repo),
  );
}

export async function githubReadme(store: Store, input: Base): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const m = requireMapping(store, project, environment, "github");
  const r = m.resource as { owner: string; repo: string };
  const label = `${r.owner}/${r.repo}`;
  return runGuarded(
    store,
    ctx(project, environment, "github", "read", "get_github_repo_readme", `readme ${label}`, {
      resourceLabel: label,
    }),
    () => gh.getReadme(tokenFor(store, "github"), r.owner, r.repo),
  );
}

export async function githubListFiles(
  store: Store,
  input: Base & { path?: string },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const m = requireMapping(store, project, environment, "github");
  const r = m.resource as { owner: string; repo: string };
  const label = `${r.owner}/${r.repo}`;
  return runGuarded(
    store,
    ctx(project, environment, "github", "read", "list_github_repo_files", `files ${label}`, {
      resourceLabel: label,
    }),
    () => gh.listFiles(tokenFor(store, "github"), r.owner, r.repo, input.path ?? ""),
  );
}

// --- Vercel ----------------------------------------------------------------

function vercelResource(store: Store, project: Project, environment: Environment) {
  const m = requireMapping(store, project, environment, "vercel");
  return m.resource as { projectId: string; projectName?: string; teamId?: string };
}

export async function vercelProjectContext(store: Store, input: Base): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const r = vercelResource(store, project, environment);
  return runGuarded(
    store,
    ctx(project, environment, "vercel", "read", "get_vercel_project_context", `project ${r.projectId}`, {
      resourceLabel: r.projectId,
    }),
    () => vc.getProjectContext(tokenFor(store, "vercel"), r.projectId, vercelTeamId(store, r.teamId)),
  );
}

export async function vercelDeployments(
  store: Store,
  input: Base & { limit?: number },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const r = vercelResource(store, project, environment);
  return runGuarded(
    store,
    ctx(project, environment, "vercel", "read", "get_vercel_deployments", `deployments ${r.projectId}`, {
      resourceLabel: r.projectId,
    }),
    () =>
      vc.listDeployments(tokenFor(store, "vercel"), r.projectId, vercelTeamId(store, r.teamId), input.limit ?? 10),
  );
}

export async function vercelDeploymentStatus(
  store: Store,
  input: Base & { deploymentId: string },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const r = vercelResource(store, project, environment);
  return runGuarded(
    store,
    ctx(project, environment, "vercel", "read", "get_vercel_deployment_status", `status ${input.deploymentId}`, {
      resourceLabel: input.deploymentId,
    }),
    () => vc.getDeploymentStatus(tokenFor(store, "vercel"), input.deploymentId, vercelTeamId(store, r.teamId)),
  );
}

export async function vercelDeploymentLogs(
  store: Store,
  input: Base & { deploymentId: string; limit?: number },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const r = vercelResource(store, project, environment);
  return runGuarded(
    store,
    ctx(project, environment, "vercel", "read", "get_vercel_deployment_logs", `logs ${input.deploymentId}`, {
      resourceLabel: input.deploymentId,
    }),
    () =>
      vc.getDeploymentLogs(tokenFor(store, "vercel"), input.deploymentId, vercelTeamId(store, r.teamId), input.limit ?? 100),
  );
}

export async function vercelSetEnvVar(
  store: Store,
  input: Base & { key: string; value: string; target?: string[] },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const r = vercelResource(store, project, environment);
  const target = input.target ?? [environment.isProduction ? "production" : "preview"];
  return runGuarded(
    store,
    ctx(project, environment, "vercel", "env_change", "set_vercel_env_var", `set env ${input.key} on ${r.projectId}`, {
      resourceLabel: `${r.projectId}:${input.key}`,
    }),
    () =>
      vc.setEnvVar(
        tokenFor(store, "vercel"),
        r.projectId,
        { key: input.key, value: input.value, target },
        vercelTeamId(store, r.teamId),
      ),
  );
}

export async function vercelCreateDeployment(
  store: Store,
  input: Base & { name?: string; deploymentId?: string },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const r = vercelResource(store, project, environment);
  const target = environment.isProduction ? "production" : "preview";
  return runGuarded(
    store,
    ctx(project, environment, "vercel", "deploy", "create_vercel_deployment", `deploy ${r.projectId} (${target})`, {
      resourceLabel: r.projectId,
    }),
    () =>
      vc.createDeployment(
        tokenFor(store, "vercel"),
        { name: input.name ?? r.projectName ?? r.projectId, project: r.projectId, target, deploymentId: input.deploymentId },
        vercelTeamId(store, r.teamId),
      ),
  );
}

// --- Supabase --------------------------------------------------------------

export async function supabaseListProjects(store: Store, input: Base): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  // Account-level read; uses the env-scoped connection only for the token + audit.
  return runGuarded(
    store,
    ctx(project, environment, "supabase", "read", "list_supabase_projects", "list supabase projects"),
    () => sb.listProjects(tokenFor(store, "supabase")),
  );
}

export async function supabaseProjectContext(store: Store, input: Base): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const m = requireMapping(store, project, environment, "supabase");
  const r = m.resource as { projectRef: string };
  return runGuarded(
    store,
    ctx(project, environment, "supabase", "read", "get_supabase_project_context", `project ${r.projectRef}`, {
      resourceLabel: r.projectRef,
    }),
    () => sb.getProject(tokenFor(store, "supabase"), r.projectRef),
  );
}

export async function supabaseQuery(
  store: Store,
  input: Base & { sql: string },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const m = requireMapping(store, project, environment, "supabase");
  const r = m.resource as { projectRef: string };
  const classified = classifySql(input.sql);
  return runGuarded(
    store,
    ctx(
      project,
      environment,
      "supabase",
      classified.capability,
      "query_supabase",
      `SQL (${classified.keyword}) on ${r.projectRef}`,
      { resourceLabel: r.projectRef },
    ),
    // Reads are sent with read_only:true (real backend enforcement). Writes that
    // are allowed by policy run as read_only:false.
    () => sb.runQuery(tokenFor(store, "supabase"), r.projectRef, input.sql, classified.readOnly),
  );
}

// --- Stripe ----------------------------------------------------------------

function stripeMode(store: Store, environment: Environment): "test" | "live" {
  const m = findMapping(store, environment, "stripe");
  if (m && m.resource.provider === "stripe") return m.resource.mode;
  // Fall back to env kind if no explicit mapping.
  return environment.isProduction ? "live" : "test";
}

export async function stripeListProducts(
  store: Store,
  input: Base & { limit?: number },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const mode = stripeMode(store, environment);
  return runGuarded(
    store,
    ctx(project, environment, "stripe", "read", "list_stripe_products", `list products (${mode})`, {
      resourceLabel: mode,
    }),
    () => st.listProducts(resolveStripeKey(mode), input.limit ?? 10),
  );
}

export async function stripeCreateProduct(
  store: Store,
  input: Base & { name: string; description?: string },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const mode = stripeMode(store, environment);
  return runGuarded(
    store,
    ctx(project, environment, "stripe", "write", "create_stripe_product", `create product "${input.name}" (${mode})`, {
      live: mode === "live",
      resourceLabel: mode,
    }),
    () => st.createProduct(resolveStripeKey(mode), { name: input.name, description: input.description }),
  );
}

export async function stripeCreatePrice(
  store: Store,
  input: Base & {
    product: string;
    currency: string;
    unitAmount: number;
    recurringInterval?: "day" | "week" | "month" | "year";
  },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const mode = stripeMode(store, environment);
  return runGuarded(
    store,
    ctx(project, environment, "stripe", "write", "create_stripe_price", `create price for ${input.product} (${mode})`, {
      live: mode === "live",
      resourceLabel: mode,
    }),
    () =>
      st.createPrice(resolveStripeKey(mode), {
        product: input.product,
        currency: input.currency,
        unitAmount: input.unitAmount,
        recurringInterval: input.recurringInterval,
      }),
  );
}
