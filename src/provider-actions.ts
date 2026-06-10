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
import * as rw from "./providers/railway.js";
import * as ne from "./providers/neon.js";
import * as nc from "./providers/namecheap.js";
import { loadRegistrantContact } from "./config.js";
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

function tokenFor(store: Store, provider: ProviderId, connectionId?: string): string {
  const conn = findConnection(store, provider, connectionId);
  if (conn) return resolveToken(conn);
  if (connectionId) {
    throw new OfflocalError(`Mapping references missing ${provider} connection "${connectionId}".`);
  }
  const envVar = defaultEnvVar(provider);
  const v = process.env[envVar];
  if (!v || v.trim().length === 0) {
    throw new OfflocalError(
      `No ${provider} connection and ${envVar} is not set. Configure credentials first.`,
    );
  }
  return v.trim();
}

function vercelTeamId(store: Store, mappingTeamId?: string, connectionId?: string): string | undefined {
  if (mappingTeamId) return mappingTeamId;
  const conn = findConnection(store, "vercel", connectionId);
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

function assertPositiveInteger(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new OfflocalError(`${name} must be a positive integer.`);
  }
}

function assertNonEmptyString(name: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new OfflocalError(`${name} must be a non-empty string.`);
  }
  return trimmed;
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
    () => gh.getRepoContext(tokenFor(store, "github", m.connectionId), r.owner, r.repo),
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
    () => gh.getReadme(tokenFor(store, "github", m.connectionId), r.owner, r.repo),
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
    () => gh.listFiles(tokenFor(store, "github", m.connectionId), r.owner, r.repo, input.path ?? ""),
  );
}

// --- Vercel ----------------------------------------------------------------

function vercelResource(store: Store, project: Project, environment: Environment) {
  const m = requireMapping(store, project, environment, "vercel");
  return { ...(m.resource as { projectId: string; projectName?: string; teamId?: string }), connectionId: m.connectionId };
}

export async function vercelProjectContext(store: Store, input: Base): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const r = vercelResource(store, project, environment);
  return runGuarded(
    store,
    ctx(project, environment, "vercel", "read", "get_vercel_project_context", `project ${r.projectId}`, {
      resourceLabel: r.projectId,
    }),
    () => vc.getProjectContext(tokenFor(store, "vercel", r.connectionId), r.projectId, vercelTeamId(store, r.teamId, r.connectionId)),
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
      {
        assertPositiveInteger("limit", input.limit);
        return vc.listDeployments(tokenFor(store, "vercel", r.connectionId), r.projectId, vercelTeamId(store, r.teamId, r.connectionId), input.limit ?? 10);
      },
  );
}

export async function githubPullRequests(
  store: Store,
  input: Base & { state?: "open" | "closed" | "all"; limit?: number },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const m = requireMapping(store, project, environment, "github");
  const r = m.resource as { owner: string; repo: string };
  const label = `${r.owner}/${r.repo}`;
  return runGuarded(
    store,
    ctx(project, environment, "github", "read", "list_github_pull_requests", `pull requests ${label}`, {
      resourceLabel: label,
    }),
    () => {
      assertPositiveInteger("limit", input.limit);
      return gh.listPullRequests(tokenFor(store, "github", m.connectionId), r.owner, r.repo, {
        state: input.state,
        limit: input.limit ?? 10,
      });
    },
  );
}

export async function githubBranches(store: Store, input: Base & { limit?: number }): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const m = requireMapping(store, project, environment, "github");
  const r = m.resource as { owner: string; repo: string };
  const label = `${r.owner}/${r.repo}`;
  return runGuarded(
    store,
    ctx(project, environment, "github", "read", "list_github_branches", `branches ${label}`, {
      resourceLabel: label,
    }),
    () => {
      assertPositiveInteger("limit", input.limit);
      return gh.listBranches(tokenFor(store, "github", m.connectionId), r.owner, r.repo, input.limit ?? 30);
    },
  );
}

export async function githubStatusChecks(store: Store, input: Base & { ref: string }): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const m = requireMapping(store, project, environment, "github");
  const r = m.resource as { owner: string; repo: string };
  const ref = assertNonEmptyString("ref", input.ref);
  const label = `${r.owner}/${r.repo}@${ref}`;
  return runGuarded(
    store,
    ctx(project, environment, "github", "read", "get_github_status_checks", `status checks ${label}`, {
      resourceLabel: label,
    }),
    () => gh.getCombinedStatus(tokenFor(store, "github", m.connectionId), r.owner, r.repo, ref),
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
    () => vc.getDeploymentStatus(tokenFor(store, "vercel", r.connectionId), input.deploymentId, vercelTeamId(store, r.teamId, r.connectionId)),
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
      {
        assertPositiveInteger("limit", input.limit);
        return vc.getDeploymentLogs(tokenFor(store, "vercel", r.connectionId), input.deploymentId, vercelTeamId(store, r.teamId, r.connectionId), input.limit ?? 100);
      },
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
        tokenFor(store, "vercel", r.connectionId),
        r.projectId,
        { key: assertNonEmptyString("key", input.key), value: input.value, target },
        vercelTeamId(store, r.teamId, r.connectionId),
      ),
  );
}

export async function vercelCreateDeployment(
  store: Store,
  input: Base & {
    name?: string;
    deploymentId?: string;
    gitSource?: { type: "github"; repoId: string; ref?: string; sha?: string };
  },
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
        tokenFor(store, "vercel", r.connectionId),
        {
          name: input.name ?? r.projectName ?? r.projectId,
          project: r.projectId,
          target,
          deploymentId: input.deploymentId,
          gitSource: input.gitSource,
        },
        vercelTeamId(store, r.teamId, r.connectionId),
      ),
  );
}

/**
 * create_vercel_project — create a Vercel project (capability "write"). No
 * mapping is required: the project usually doesn't exist locally yet; any
 * existing Vercel mapping only supplies credentials/team scope.
 */
export async function vercelCreateProject(
  store: Store,
  input: Base & { name: string; framework?: string },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const name = assertNonEmptyString("name", input.name);
  const mapping = findMapping(store, environment, "vercel");
  const teamId = mapping?.resource.provider === "vercel" ? mapping.resource.teamId : undefined;
  return runGuarded(
    store,
    ctx(project, environment, "vercel", "write", "create_vercel_project", `create Vercel project ${name}`, {
      resourceLabel: name,
    }),
    () =>
      vc.createProject(
        tokenFor(store, "vercel", mapping?.connectionId),
        { name, framework: input.framework },
        vercelTeamId(store, teamId, mapping?.connectionId),
      ),
  );
}

/**
 * add_vercel_domain — attach a domain to a Vercel project (capability
 * "write"). The result includes the DNS target (A 76.76.21.21 for apex,
 * CNAME cname.vercel-dns.com for subdomains) to set at the registrar.
 */
export async function vercelAddDomain(
  store: Store,
  input: Base & { vercelProject: string; domain: string },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const vercelProject = assertNonEmptyString("vercelProject", input.vercelProject);
  const domain = assertNonEmptyString("domain", input.domain);
  const mapping = findMapping(store, environment, "vercel");
  const teamId = mapping?.resource.provider === "vercel" ? mapping.resource.teamId : undefined;
  return runGuarded(
    store,
    ctx(project, environment, "vercel", "write", "add_vercel_domain", `attach ${domain} to Vercel project ${vercelProject}`, {
      resourceLabel: `${vercelProject}:${domain}`,
    }),
    () =>
      vc.addProjectDomain(
        tokenFor(store, "vercel", mapping?.connectionId),
        vercelProject,
        domain,
        vercelTeamId(store, teamId, mapping?.connectionId),
      ),
  );
}

// --- App logs --------------------------------------------------------------
//
// Log reads are a "read" capability, so they are allowed by default in every
// environment (including production) and audited like any other guarded action.

/** Providers that can serve app logs in V0, in priority order (Vercel first). */
const LOG_PROVIDERS: ProviderId[] = ["vercel", "railway"];

interface NormalizedLog {
  timestamp: string;
  level: string;
  message: string;
}

interface LogResult {
  resource: Record<string, unknown>;
  time_range: { since?: string };
  logs: NormalizedLog[];
  limitation?: string;
  audit_written: true;
}

/**
 * Best-effort redaction so a log read never echoes a secret back to the agent.
 * Conservative substring/pattern matching only — better to leave a real log
 * line intact than to mangle it, but obvious credential shapes are masked.
 */
function redactSecrets(text: string): string {
  if (!text) return text;
  return text
    // Provider/key tokens with recognizable prefixes.
    .replace(/\b(sk_live|sk_test|rk_live|rk_test)_[A-Za-z0-9]{6,}/g, "$1_***REDACTED***")
    .replace(/\bghp_[A-Za-z0-9]{20,}/g, "ghp_***REDACTED***")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "github_pat_***REDACTED***")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "AKIA***REDACTED***")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "***REDACTED_JWT***")
    // Authorization: Bearer <token>
    .replace(/(authorization:\s*bearer\s+)\S+/gi, "$1***REDACTED***")
    // Credentials embedded in connection strings (postgres://user:pass@host).
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@]+(@)/gi, "$1***REDACTED***$2")
    // KEY=value where the key name looks secret-bearing.
    .replace(
      /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_?KEY|PRIVATE_KEY)[A-Z0-9_]*)\s*[=:]\s*("?)[^\s"]+\2/gi,
      "$1=***REDACTED***",
    );
}

function normalizeVercelEvent(e: vc.VercelLogEvent): NormalizedLog {
  const level = e.type === "stderr" || e.type === "error" ? "error" : "info";
  const timestamp =
    typeof e.created === "number" && e.created > 0 ? new Date(e.created).toISOString() : "";
  return { level, timestamp, message: redactSecrets(e.text ?? "") };
}

function normalizeRailwayLog(l: rw.RailwayLog): NormalizedLog {
  const sev = (l.severity ?? "").toLowerCase();
  const level = /err|fatal|crit/.test(sev) ? "error" : /warn/.test(sev) ? "warn" : "info";
  return { level, timestamp: l.timestamp ?? "", message: redactSecrets(l.message ?? "") };
}

/** Prefix a bare host (e.g. "app.up.railway.app") with https:// if it has no scheme. */
function httpsUrl(u?: string): string | undefined {
  if (!u) return undefined;
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

/** Validate the optional `since` filter before any provider calls are made. */
function assertValidSince(since?: string): void {
  if (!since) return;
  const asNum = Number(since);
  if (Number.isFinite(asNum) && asNum > 0) return;
  const parsed = Date.parse(since);
  if (Number.isNaN(parsed)) {
    throw new OfflocalError("since must be a positive epoch millisecond value or a valid ISO timestamp.");
  }
}

/** Parse the optional `since` (epoch ms or ISO timestamp) into epoch ms. */
function sinceMs(since?: string): number | undefined {
  assertValidSince(since);
  if (!since) return undefined;
  const asNum = Number(since);
  if (Number.isFinite(asNum) && asNum > 0) return asNum;
  return Date.parse(since);
}

/**
 * Resolve the target deployment (latest if none given), then fetch its logs.
 * Runs inside the guarded `exec` thunk. Log-availability problems are returned
 * as a `limitation` (with the deployment status still attached) rather than
 * thrown, so the read never fails silently.
 */
async function fetchVercelLogsData(
  token: string,
  r: { projectId: string; teamId?: string },
  teamId: string | undefined,
  opts: { deploymentId?: string; since?: string; limit?: number },
): Promise<LogResult> {
  assertPositiveInteger("limit", opts.limit);
  const since = sinceMs(opts.since);
  const limit = opts.limit ?? 100;
  const time_range = { since: opts.since };

  let deploymentId = opts.deploymentId;
  let deployment_url: string | undefined;
  let deployment_status: string | undefined;

  if (!deploymentId) {
    const deps = await vc.listDeployments(token, r.projectId, teamId, 1);
    if (deps.length === 0) {
      return {
        resource: { project: r.projectId },
        time_range,
        logs: [],
        limitation: "No deployments found for this Vercel project — nothing to fetch logs for.",
        audit_written: true,
      };
    }
    const latest = deps[0]!;
    deploymentId = latest.uid;
    deployment_url = latest.url ? `https://${latest.url}` : undefined;
    deployment_status = latest.readyState ?? latest.state;
  } else {
    // Explicit deployment id: fetch its status so we can report url/state.
    try {
      const status = await vc.getDeploymentStatus(token, deploymentId, teamId);
      if (typeof status.readyState === "string") deployment_status = status.readyState;
      if (typeof status.url === "string") deployment_url = `https://${status.url}`;
    } catch {
      /* best-effort — logs may still be fetchable */
    }
  }

  const resource = {
    project: r.projectId,
    deployment_id: deploymentId,
    deployment_url,
    deployment_status,
  };

  try {
    const events = await vc.getDeploymentLogs(token, deploymentId, teamId, limit, since);
    const logs = events.map(normalizeVercelEvent);
    const limitation =
      logs.length === 0
        ? "Vercel's events API returned no log lines. It exposes build logs and recent " +
          "runtime events; older runtime logs require a configured log drain and are not " +
          "available through this API."
        : undefined;
    return { resource, time_range, logs, limitation, audit_written: true };
  } catch (err) {
    return {
      resource,
      time_range,
      logs: [],
      limitation:
        `Could not fetch deployment logs (${err instanceof Error ? err.message : String(err)}). ` +
        "Returning the deployment status only.",
      audit_written: true,
    };
  }
}

/** Shared guarded Vercel log read; `tool` distinguishes the audited entry. */
function runVercelLogs(
  store: Store,
  input: Base & { deploymentId?: string; since?: string; limit?: number },
  tool: string,
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const r = vercelResource(store, project, environment);
  const teamId = vercelTeamId(store, r.teamId, r.connectionId);
  const label = input.deploymentId ?? r.projectId;
  return runGuarded(
    store,
    ctx(project, environment, "vercel", "read", tool, `logs ${label}`, { resourceLabel: label }),
    () =>
      fetchVercelLogsData(tokenFor(store, "vercel", r.connectionId), r, teamId, {
        deploymentId: input.deploymentId,
        since: input.since,
        limit: input.limit,
      }),
  );
}

/** get_vercel_logs — Vercel-specific; resolves latest deployment if none given. */
export function vercelLogs(
  store: Store,
  input: Base & { deploymentId?: string; since?: string; limit?: number },
): Promise<GuardedResponse> {
  return runVercelLogs(store, input, "get_vercel_logs");
}

// --- Railway (logs) --------------------------------------------------------

function railwayResource(store: Store, project: Project, environment: Environment) {
  const m = requireMapping(store, project, environment, "railway");
  return { ...(m.resource as {
    projectId: string;
    environmentId?: string;
    serviceId?: string;
    projectName?: string;
  }), connectionId: m.connectionId };
}

/**
 * Resolve the target Railway deployment (latest if none given) and fetch its
 * logs. Mirrors fetchVercelLogsData: log-availability problems become a
 * `limitation` (with status attached) rather than a thrown error.
 */
async function fetchRailwayLogsData(
  token: string,
  r: { projectId: string; environmentId?: string; serviceId?: string },
  opts: { deploymentId?: string; since?: string; limit?: number },
): Promise<LogResult> {
  assertPositiveInteger("limit", opts.limit);
  assertValidSince(opts.since);
  const limit = opts.limit ?? 100;
  const time_range = { since: opts.since };

  let deploymentId = opts.deploymentId;
  let deployment_url: string | undefined;
  let deployment_status: string | undefined;

  if (!deploymentId) {
    const deps = await rw.listDeployments(
      token,
      { projectId: r.projectId, environmentId: r.environmentId, serviceId: r.serviceId },
      1,
    );
    if (deps.length === 0) {
      return {
        resource: { project: r.projectId },
        time_range,
        logs: [],
        limitation: "No deployments found for this Railway project/service — nothing to fetch logs for.",
        audit_written: true,
      };
    }
    const latest = deps[0]!;
    deploymentId = latest.id;
    deployment_url = httpsUrl(latest.staticUrl ?? latest.url);
    deployment_status = latest.status;
  }

  const resource = {
    project: r.projectId,
    deployment_id: deploymentId,
    deployment_url,
    deployment_status,
  };

  try {
    const raw = await rw.getDeploymentLogs(token, deploymentId, limit, opts.since);
    const logs = raw.map(normalizeRailwayLog);
    const limitation =
      logs.length === 0
        ? "Railway returned no log lines for this deployment (logs may have expired or the " +
          "deployment produced none)."
        : undefined;
    return { resource, time_range, logs, limitation, audit_written: true };
  } catch (err) {
    return {
      resource,
      time_range,
      logs: [],
      limitation:
        `Could not fetch Railway deployment logs (${err instanceof Error ? err.message : String(err)}). ` +
        "Returning the deployment status only.",
      audit_written: true,
    };
  }
}

/** Shared guarded Railway log read; `tool` distinguishes the audited entry. */
function runRailwayLogs(
  store: Store,
  input: Base & { deploymentId?: string; since?: string; limit?: number },
  tool: string,
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const r = railwayResource(store, project, environment);
  const label = input.deploymentId ?? r.projectId;
  return runGuarded(
    store,
    ctx(project, environment, "railway", "read", tool, `logs ${label}`, { resourceLabel: label }),
    () =>
      fetchRailwayLogsData(tokenFor(store, "railway", r.connectionId), r, {
        deploymentId: input.deploymentId,
        since: input.since,
        limit: input.limit,
      }),
  );
}

/** get_railway_logs — Railway-specific; resolves latest deployment if none given. */
export function railwayLogs(
  store: Store,
  input: Base & { deploymentId?: string; since?: string; limit?: number },
): Promise<GuardedResponse> {
  return runRailwayLogs(store, input, "get_railway_logs");
}

/** get_railway_project_context — Railway project + its environments/services. */
export async function railwayProjectContext(store: Store, input: Base): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const r = railwayResource(store, project, environment);
  return runGuarded(
    store,
    ctx(project, environment, "railway", "read", "get_railway_project_context", `project ${r.projectId}`, {
      resourceLabel: r.projectId,
    }),
    () => rw.getProject(tokenFor(store, "railway", r.connectionId), r.projectId),
  );
}

/** get_railway_deployments — recent deployments for the mapped project/service. */
export async function railwayDeployments(
  store: Store,
  input: Base & { limit?: number },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const r = railwayResource(store, project, environment);
  return runGuarded(
    store,
    ctx(project, environment, "railway", "read", "get_railway_deployments", `deployments ${r.projectId}`, {
      resourceLabel: r.projectId,
    }),
    () => {
      assertPositiveInteger("limit", input.limit);
      return rw.listDeployments(
        tokenFor(store, "railway", r.connectionId),
        { projectId: r.projectId, environmentId: r.environmentId, serviceId: r.serviceId },
        input.limit ?? 10,
      );
    },
  );
}

export async function railwayDiscover(store: Store, input: Base): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const mapping = findMapping(store, environment, "railway");
  return runGuarded(
    store,
    ctx(project, environment, "railway", "read", "discover_railway_resources", "discover railway projects"),
    () => rw.listProjects(tokenFor(store, "railway", mapping?.connectionId)),
  );
}

/**
 * create_railway_deployment — trigger a deployment of the mapped Railway
 * service, or redeploy an existing deployment by id. PRODUCTION deploys require
 * approval by default (capability "deploy").
 */
export async function railwayCreateDeployment(
  store: Store,
  input: Base & { deploymentId?: string },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const r = railwayResource(store, project, environment);
  const label = input.deploymentId ?? r.projectId;
  return runGuarded(
    store,
    ctx(project, environment, "railway", "deploy", "create_railway_deployment", `deploy ${label}`, {
      resourceLabel: label,
    }),
    () => {
      const token = tokenFor(store, "railway", r.connectionId);
      if (input.deploymentId) return rw.redeploy(token, input.deploymentId);
      if (!r.environmentId || !r.serviceId) {
        throw new OfflocalError(
          "Railway deploy needs the mapping to include environmentId and serviceId " +
            "(or pass deploymentId to redeploy an existing deployment).",
        );
      }
      return rw.triggerDeploy(token, {
        projectId: r.projectId,
        environmentId: r.environmentId,
        serviceId: r.serviceId,
      });
    },
  );
}

/**
 * set_railway_env_var — create/update a Railway variable. PRODUCTION env changes
 * require approval by default (capability "env_change"). Railway redeploys the
 * affected service on change unless `skipDeploys` is true.
 */
export async function railwaySetEnvVar(
  store: Store,
  input: Base & { key: string; value: string; serviceId?: string; skipDeploys?: boolean },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const r = railwayResource(store, project, environment);
  return runGuarded(
    store,
    ctx(project, environment, "railway", "env_change", "set_railway_env_var", `set var ${input.key} on ${r.projectId}`, {
      resourceLabel: `${r.projectId}:${input.key}`,
    }),
    () => {
      if (!r.environmentId) {
        throw new OfflocalError(
          "Railway variable changes need the mapping to include environmentId.",
        );
      }
      return rw.upsertVariable(tokenFor(store, "railway", r.connectionId), {
        projectId: r.projectId,
        environmentId: r.environmentId,
        serviceId: input.serviceId ?? r.serviceId,
        name: assertNonEmptyString("key", input.key),
        value: input.value,
        skipDeploys: input.skipDeploys,
      });
    },
  );
}

// --- Namecheap -----------------------------------------------------------------

/** check_domain_availability — availability + premium pricing (read-only). */
export async function checkDomainAvailability(
  store: Store,
  input: Base & { domains: string[] },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  if (!Array.isArray(input.domains) || input.domains.length === 0) {
    throw new OfflocalError("domains must be a non-empty list of domain names.");
  }
  const label = input.domains.join(",");
  return runGuarded(
    store,
    ctx(project, environment, "namecheap", "read", "check_domain_availability", `check availability of ${label}`, {
      resourceLabel: label,
    }),
    () => nc.checkDomains(tokenFor(store, "namecheap"), input.domains),
  );
}

/** list_namecheap_domains — domains in the Namecheap account (read-only). */
export async function namecheapListDomains(
  store: Store,
  input: Base & { page?: number; pageSize?: number; searchTerm?: string },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  return runGuarded(
    store,
    ctx(project, environment, "namecheap", "read", "list_namecheap_domains", "list Namecheap domains"),
    () => {
      assertPositiveInteger("page", input.page);
      assertPositiveInteger("pageSize", input.pageSize);
      return nc.listDomains(tokenFor(store, "namecheap"), {
        page: input.page,
        pageSize: input.pageSize,
        searchTerm: input.searchTerm,
      });
    },
  );
}

/**
 * purchase_domain — registers a domain and SPENDS REAL MONEY. Capability
 * "purchase" is clamped to approval_required by policy and marked live, so it
 * always needs a human. The registrant contact is validated before any HTTP
 * (including the DashClaw guard call) so a missing config never burns an
 * approval round-trip.
 */
export async function purchaseDomain(
  store: Store,
  input: Base & { domain: string; years?: number },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const domain = assertNonEmptyString("domain", input.domain);
  const registrant = loadRegistrantContact(store.paths.config);
  if (!registrant) {
    throw new OfflocalError(
      `Domain purchase needs a registrant contact. Add a "namecheap.registrant" block to ` +
        `${store.paths.config} with first_name, last_name, address1, city, state_province, ` +
        `postal_code, country, phone (format +1.NNNNNNNNNN), email_address — then retry.`,
    );
  }
  return runGuarded(
    store,
    ctx(project, environment, "namecheap", "purchase", "purchase_domain", `purchase domain ${domain}`, {
      live: true,
      resourceLabel: domain,
    }),
    () => {
      assertPositiveInteger("years", input.years);
      return nc.createDomain(tokenFor(store, "namecheap"), {
        domain,
        years: input.years,
        registrant,
      });
    },
  );
}

/** get_dns_records — DNS host records for a domain (read-only). */
export async function getDnsRecords(
  store: Store,
  input: Base & { domain: string },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const domain = assertNonEmptyString("domain", input.domain);
  return runGuarded(
    store,
    ctx(project, environment, "namecheap", "read", "get_dns_records", `DNS records for ${domain}`, {
      resourceLabel: domain,
    }),
    () => nc.getDnsHosts(tokenFor(store, "namecheap"), domain),
  );
}

/**
 * set_dns_records — REPLACES ALL host records for the domain (Namecheap
 * setHosts semantics). Capability "env_change": approval required in
 * production by default.
 */
export async function setDnsRecords(
  store: Store,
  input: Base & { domain: string; records: nc.DnsRecordInput[] },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const domain = assertNonEmptyString("domain", input.domain);
  if (!Array.isArray(input.records) || input.records.length === 0) {
    throw new OfflocalError(
      "records must be a non-empty list — setHosts REPLACES ALL host records, so an empty list would wipe the domain's DNS.",
    );
  }
  return runGuarded(
    store,
    ctx(project, environment, "namecheap", "env_change", "set_dns_records", `REPLACE all DNS host records for ${domain}`, {
      resourceLabel: domain,
    }),
    () => nc.setDnsHosts(tokenFor(store, "namecheap"), domain, input.records),
  );
}

// --- Neon --------------------------------------------------------------------

/** list_neon_projects — Neon projects visible to the API key (read-only). */
export async function neonListProjects(store: Store, input: Base): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  return runGuarded(
    store,
    ctx(project, environment, "neon", "read", "list_neon_projects", "list Neon projects"),
    () => ne.listProjects(tokenFor(store, "neon")),
  );
}

/** create_neon_project — provision a Neon project (capability "write"). */
export async function neonCreateProject(
  store: Store,
  input: Base & { name?: string; regionId?: string; pgVersion?: number },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const label = input.name ?? "(default name)";
  return runGuarded(
    store,
    ctx(project, environment, "neon", "write", "create_neon_project", `create Neon project ${label}`, {
      resourceLabel: label,
    }),
    () =>
      ne.createProject(tokenFor(store, "neon"), {
        name: input.name,
        regionId: input.regionId,
        pgVersion: input.pgVersion,
      }),
  );
}

/**
 * get_neon_connection_uri — fetch the connection URI for a Neon project. The
 * URI (with credentials) goes to the tool result ONLY; summary and resource
 * label deliberately name the project, never the URI.
 */
export async function neonGetConnectionUri(
  store: Store,
  input: Base & {
    neonProjectId: string;
    databaseName: string;
    roleName: string;
    branchId?: string;
    pooled?: boolean;
  },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const id = assertNonEmptyString("neonProjectId", input.neonProjectId);
  return runGuarded(
    store,
    ctx(project, environment, "neon", "read", "get_neon_connection_uri", `connection URI for Neon project ${id}`, {
      resourceLabel: id,
    }),
    () =>
      ne.getConnectionUri(tokenFor(store, "neon"), {
        projectId: id,
        databaseName: assertNonEmptyString("databaseName", input.databaseName),
        roleName: assertNonEmptyString("roleName", input.roleName),
        branchId: input.branchId,
        pooled: input.pooled,
      }),
  );
}

/** get_latest_deployment_logs — convenience; latest deployment for the provider. */
export async function latestDeploymentLogs(
  store: Store,
  input: Base & { provider?: ProviderId },
): Promise<GuardedResponse> {
  const provider = input.provider ?? "vercel";
  const base = { project: input.project, environment: input.environment };
  if (provider === "vercel") {
    return runVercelLogs(store, base, "get_latest_deployment_logs");
  }
  if (provider === "railway") {
    return runRailwayLogs(store, base, "get_latest_deployment_logs");
  }
  // Other providers don't serve deployment logs in V0 — audit the read and
  // return a clear limitation instead of pretending.
  const { project, environment } = resolve(store, input);
  return runGuarded(
    store,
    ctx(project, environment, provider, "read", "get_latest_deployment_logs", `latest logs (${provider})`),
    async (): Promise<LogResult> => ({
      resource: { provider },
      time_range: {},
      logs: [],
      limitation: `Log fetching for ${provider} is not supported in V0 — only Vercel and Railway logs are available.`,
      audit_written: true,
    }),
  );
}

/**
 * get_app_logs — generic entry point. With an explicit `provider`, reads that
 * provider only; otherwise reads every mapped provider that supports logs
 * (Vercel prioritized). Each provider read is independently policy-checked and
 * audited; results are returned per provider.
 */
export async function appLogs(
  store: Store,
  input: Base & { provider?: ProviderId; deploymentId?: string; since?: string; limit?: number },
): Promise<{
  status: "ok";
  project: string;
  environment: string;
  providers: GuardedResponse[];
  limitation?: string;
}> {
  const { project, environment } = resolve(store, input);

  const targets: ProviderId[] = input.provider
    ? [input.provider]
    : LOG_PROVIDERS.filter((p) => !!findMapping(store, environment, p));

  if (targets.length === 0) {
    return {
      status: "ok",
      project: project.slug,
      environment: environment.name,
      providers: [],
      limitation:
        "No mapped providers support log fetching for this environment. Map a Vercel or " +
        "Railway project with map_provider_resource, or pass an explicit `provider`.",
    };
  }

  const logInput = {
    project: input.project,
    environment: input.environment,
    deploymentId: input.deploymentId,
    since: input.since,
    limit: input.limit,
  };

  const providers: GuardedResponse[] = [];
  for (const p of targets) {
    if (p === "vercel") {
      providers.push(await runVercelLogs(store, logInput, "get_app_logs"));
    } else if (p === "railway") {
      providers.push(await runRailwayLogs(store, logInput, "get_app_logs"));
    } else {
      providers.push(
        await runGuarded(
          store,
          ctx(project, environment, p, "read", "get_app_logs", `logs (${p})`),
          async (): Promise<LogResult> => ({
            resource: { provider: p },
            time_range: { since: input.since },
            logs: [],
            limitation: `Log fetching for ${p} is not supported in V0 — only Vercel and Railway logs are available.`,
            audit_written: true,
          }),
        ),
      );
    }
  }

  return { status: "ok", project: project.slug, environment: environment.name, providers };
}

// --- Supabase --------------------------------------------------------------

export async function supabaseListProjects(store: Store, input: Base): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  // Account-level read; uses the env-scoped connection only for the token + audit.
  const mapping = findMapping(store, environment, "supabase");
  return runGuarded(
    store,
    ctx(project, environment, "supabase", "read", "list_supabase_projects", "list supabase projects"),
    () => sb.listProjects(tokenFor(store, "supabase", mapping?.connectionId)),
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
    () => sb.getProject(tokenFor(store, "supabase", m.connectionId), r.projectRef),
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
    () => sb.runQuery(tokenFor(store, "supabase", m.connectionId), r.projectRef, assertNonEmptyString("sql", input.sql), classified.readOnly),
  );
}

export async function supabaseLogs(
  store: Store,
  input: Base & { service?: string; since?: string; limit?: number },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const m = requireMapping(store, project, environment, "supabase");
  const r = m.resource as { projectRef: string };
  return runGuarded(
    store,
    ctx(project, environment, "supabase", "read", "get_supabase_logs", `logs ${r.projectRef}`, {
      resourceLabel: r.projectRef,
    }),
    () => {
      assertPositiveInteger("limit", input.limit);
      return sb.getProjectLogs(tokenFor(store, "supabase", m.connectionId), r.projectRef, {
        service: input.service,
        since: input.since,
        limit: input.limit ?? 100,
      });
    },
  );
}

export async function supabaseApplyMigration(
  store: Store,
  input: Base & { name: string; sql: string },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const m = requireMapping(store, project, environment, "supabase");
  const r = m.resource as { projectRef: string };
  return runGuarded(
    store,
    ctx(project, environment, "supabase", "write", "apply_supabase_migration", `migration ${input.name} on ${r.projectRef}`, {
      resourceLabel: r.projectRef,
    }),
    () =>
      sb.applyMigration(tokenFor(store, "supabase", m.connectionId), r.projectRef, {
        name: assertNonEmptyString("name", input.name),
        query: assertNonEmptyString("sql", input.sql),
      }),
  );
}

// --- Stripe ----------------------------------------------------------------

function stripeMode(store: Store, environment: Environment): "test" | "live" {
  const m = findMapping(store, environment, "stripe");
  if (m && m.resource.provider === "stripe") return m.resource.mode;
  // Fall back to env kind if no explicit mapping.
  return environment.isProduction ? "live" : "test";
}

function stripeKeyFor(store: Store, environment: Environment, mode: "test" | "live"): string {
  const m = findMapping(store, environment, "stripe");
  if (m?.connectionId) return tokenFor(store, "stripe", m.connectionId);
  return resolveStripeKey(mode);
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
    () => {
      assertPositiveInteger("limit", input.limit);
      return st.listProducts(stripeKeyFor(store, environment, mode), input.limit ?? 10);
    },
  );
}

export async function stripeListCustomers(
  store: Store,
  input: Base & { limit?: number },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const mode = stripeMode(store, environment);
  return runGuarded(
    store,
    ctx(project, environment, "stripe", "read", "list_stripe_customers", `list customers (${mode})`, {
      resourceLabel: mode,
    }),
    () => {
      assertPositiveInteger("limit", input.limit);
      return st.listCustomers(stripeKeyFor(store, environment, mode), input.limit ?? 10);
    },
  );
}

export async function stripeListSubscriptions(
  store: Store,
  input: Base & { limit?: number; status?: string },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const mode = stripeMode(store, environment);
  return runGuarded(
    store,
    ctx(project, environment, "stripe", "read", "list_stripe_subscriptions", `list subscriptions (${mode})`, {
      resourceLabel: mode,
    }),
    () => {
      assertPositiveInteger("limit", input.limit);
      return st.listSubscriptions(stripeKeyFor(store, environment, mode), {
        limit: input.limit ?? 10,
        status: input.status,
      });
    },
  );
}

export async function stripeListInvoices(
  store: Store,
  input: Base & { limit?: number; customer?: string },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const mode = stripeMode(store, environment);
  return runGuarded(
    store,
    ctx(project, environment, "stripe", "read", "list_stripe_invoices", `list invoices (${mode})`, {
      resourceLabel: mode,
    }),
    () => {
      assertPositiveInteger("limit", input.limit);
      return st.listInvoices(stripeKeyFor(store, environment, mode), {
        limit: input.limit ?? 10,
        customer: input.customer,
      });
    },
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
    () => st.createProduct(stripeKeyFor(store, environment, mode), { name: assertNonEmptyString("name", input.name), description: input.description }),
  );
}

/**
 * create_stripe_webhook — create a webhook endpoint (capability "write").
 * Stripe returns the whsec_ signing secret ONLY at creation; it goes to the
 * tool result and is redacted from audit + DashClaw by the sanitizer.
 */
export async function stripeCreateWebhook(
  store: Store,
  input: Base & { url: string; enabledEvents: string[]; description?: string },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const mode = stripeMode(store, environment);
  const url = assertNonEmptyString("url", input.url);
  return runGuarded(
    store,
    ctx(project, environment, "stripe", "write", "create_stripe_webhook", `create webhook endpoint for ${url} (${mode})`, {
      live: mode === "live",
      resourceLabel: mode,
    }),
    () => {
      if (!Array.isArray(input.enabledEvents) || input.enabledEvents.length === 0) {
        throw new OfflocalError("enabledEvents must be a non-empty list of Stripe event names.");
      }
      return st.createWebhookEndpoint(stripeKeyFor(store, environment, mode), {
        url,
        enabledEvents: input.enabledEvents,
        description: input.description,
      });
    },
  );
}

/** list_stripe_webhooks — webhook endpoints for the environment's mode (read). */
export async function stripeListWebhooks(
  store: Store,
  input: Base & { limit?: number },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const mode = stripeMode(store, environment);
  return runGuarded(
    store,
    ctx(project, environment, "stripe", "read", "list_stripe_webhooks", `list webhook endpoints (${mode})`, {
      resourceLabel: mode,
    }),
    () => {
      assertPositiveInteger("limit", input.limit);
      return st.listWebhookEndpoints(stripeKeyFor(store, environment, mode), input.limit ?? 10);
    },
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
    () => {
      assertPositiveInteger("unitAmount", input.unitAmount);
      return st.createPrice(stripeKeyFor(store, environment, mode), {
        product: input.product,
        currency: input.currency,
        unitAmount: input.unitAmount,
        recurringInterval: input.recurringInterval,
      });
    },
  );
}
