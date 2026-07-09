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
import * as rd from "./providers/render.js";
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

/**
 * Resolve the provider token for a call. When `connectionId` is given (from the
 * mapping the action is operating on), the token is read from THAT connection's
 * env var — this is what lets two projects use two different accounts of the
 * same provider. Falls back to the provider's default connection / env var.
 */
export function tokenFor(store: Store, provider: ProviderId, connectionId?: string): string {
  const conn = findConnection(store, provider, connectionId);
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

export function vercelTeamId(
  store: Store,
  mappingTeamId?: string,
  connectionId?: string,
): string | undefined {
  if (mappingTeamId) return mappingTeamId;
  const conn = connectionId
    ? store.data.connections.find((c) => c.id === connectionId)
    : store.data.connections.find((c) => c.provider === "vercel");
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
  return {
    r: m.resource as { projectId: string; projectName?: string; teamId?: string },
    connectionId: m.connectionId,
  };
}

export async function vercelProjectContext(store: Store, input: Base): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const { r, connectionId } = vercelResource(store, project, environment);
  return runGuarded(
    store,
    ctx(project, environment, "vercel", "read", "get_vercel_project_context", `project ${r.projectId}`, {
      resourceLabel: r.projectId,
    }),
    () => vc.getProjectContext(tokenFor(store, "vercel", connectionId), r.projectId, vercelTeamId(store, r.teamId, connectionId)),
  );
}

export async function vercelDeployments(
  store: Store,
  input: Base & { limit?: number },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const { r, connectionId } = vercelResource(store, project, environment);
  return runGuarded(
    store,
    ctx(project, environment, "vercel", "read", "get_vercel_deployments", `deployments ${r.projectId}`, {
      resourceLabel: r.projectId,
    }),
    () =>
      vc.listDeployments(tokenFor(store, "vercel", connectionId), r.projectId, vercelTeamId(store, r.teamId, connectionId), input.limit ?? 10),
  );
}

export async function vercelDeploymentStatus(
  store: Store,
  input: Base & { deploymentId: string },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const { r, connectionId } = vercelResource(store, project, environment);
  return runGuarded(
    store,
    ctx(project, environment, "vercel", "read", "get_vercel_deployment_status", `status ${input.deploymentId}`, {
      resourceLabel: input.deploymentId,
    }),
    () => vc.getDeploymentStatus(tokenFor(store, "vercel", connectionId), input.deploymentId, vercelTeamId(store, r.teamId, connectionId)),
  );
}

export async function vercelDeploymentLogs(
  store: Store,
  input: Base & { deploymentId: string; limit?: number },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const { r, connectionId } = vercelResource(store, project, environment);
  return runGuarded(
    store,
    ctx(project, environment, "vercel", "read", "get_vercel_deployment_logs", `logs ${input.deploymentId}`, {
      resourceLabel: input.deploymentId,
    }),
    () =>
      vc.getDeploymentLogs(tokenFor(store, "vercel", connectionId), input.deploymentId, vercelTeamId(store, r.teamId, connectionId), input.limit ?? 100),
  );
}

export async function vercelSetEnvVar(
  store: Store,
  input: Base & { key: string; value: string; target?: string[] },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const { r, connectionId } = vercelResource(store, project, environment);
  const target = input.target ?? [environment.isProduction ? "production" : "preview"];
  return runGuarded(
    store,
    ctx(project, environment, "vercel", "env_change", "set_vercel_env_var", `set env ${input.key} on ${r.projectId}`, {
      resourceLabel: `${r.projectId}:${input.key}`,
    }),
    () =>
      vc.setEnvVar(
        tokenFor(store, "vercel", connectionId),
        r.projectId,
        { key: input.key, value: input.value, target },
        vercelTeamId(store, r.teamId, connectionId),
      ),
  );
}

export async function vercelCreateDeployment(
  store: Store,
  input: Base & { name?: string; deploymentId?: string },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const { r, connectionId } = vercelResource(store, project, environment);
  const target = environment.isProduction ? "production" : "preview";
  return runGuarded(
    store,
    ctx(project, environment, "vercel", "deploy", "create_vercel_deployment", `deploy ${r.projectId} (${target})`, {
      resourceLabel: r.projectId,
    }),
    () =>
      vc.createDeployment(
        tokenFor(store, "vercel", connectionId),
        { name: input.name ?? r.projectName ?? r.projectId, project: r.projectId, target, deploymentId: input.deploymentId },
        vercelTeamId(store, r.teamId, connectionId),
      ),
  );
}

// --- App logs --------------------------------------------------------------
//
// Log reads are a "read" capability, so they are allowed by default in every
// environment (including production) and audited like any other guarded action.

/** Providers that can serve app logs in V0, in priority order (Vercel first). */
const LOG_PROVIDERS: ProviderId[] = ["vercel", "railway", "render"];

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

function normalizeRenderLog(l: rd.RenderLog): NormalizedLog {
  const lvl = (l.level ?? "").toLowerCase();
  const level = /err|fatal|crit/.test(lvl) ? "error" : /warn/.test(lvl) ? "warn" : "info";
  return { level, timestamp: l.timestamp ?? "", message: redactSecrets(l.message ?? "") };
}

/** Prefix a bare host (e.g. "app.up.railway.app") with https:// if it has no scheme. */
function httpsUrl(u?: string): string | undefined {
  if (!u) return undefined;
  return /^https?:\/\//i.test(u) ? u : `https://${u}`;
}

/** Parse the optional `since` (epoch ms or ISO timestamp) into epoch ms. */
function sinceMs(since?: string): number | undefined {
  if (!since) return undefined;
  const asNum = Number(since);
  if (Number.isFinite(asNum) && asNum > 0) return asNum;
  const parsed = Date.parse(since);
  return Number.isNaN(parsed) ? undefined : parsed;
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
    const events = await vc.getDeploymentLogs(token, deploymentId, teamId, limit, sinceMs(opts.since));
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
  const { r, connectionId } = vercelResource(store, project, environment);
  const teamId = vercelTeamId(store, r.teamId, connectionId);
  const label = input.deploymentId ?? r.projectId;
  return runGuarded(
    store,
    ctx(project, environment, "vercel", "read", tool, `logs ${label}`, { resourceLabel: label }),
    () =>
      fetchVercelLogsData(tokenFor(store, "vercel", connectionId), r, teamId, {
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
  return {
    r: m.resource as {
      projectId: string;
      environmentId?: string;
      serviceId?: string;
      projectName?: string;
    },
    connectionId: m.connectionId,
  };
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
  const { r, connectionId } = railwayResource(store, project, environment);
  const label = input.deploymentId ?? r.projectId;
  return runGuarded(
    store,
    ctx(project, environment, "railway", "read", tool, `logs ${label}`, { resourceLabel: label }),
    () =>
      fetchRailwayLogsData(tokenFor(store, "railway", connectionId), r, {
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
  const { r, connectionId } = railwayResource(store, project, environment);
  return runGuarded(
    store,
    ctx(project, environment, "railway", "read", "get_railway_project_context", `project ${r.projectId}`, {
      resourceLabel: r.projectId,
    }),
    () => rw.getProject(tokenFor(store, "railway", connectionId), r.projectId),
  );
}

/** get_railway_deployments — recent deployments for the mapped project/service. */
export async function railwayDeployments(
  store: Store,
  input: Base & { limit?: number },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const { r, connectionId } = railwayResource(store, project, environment);
  return runGuarded(
    store,
    ctx(project, environment, "railway", "read", "get_railway_deployments", `deployments ${r.projectId}`, {
      resourceLabel: r.projectId,
    }),
    () =>
      rw.listDeployments(
        tokenFor(store, "railway", connectionId),
        { projectId: r.projectId, environmentId: r.environmentId, serviceId: r.serviceId },
        input.limit ?? 10,
      ),
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
  const { r, connectionId } = railwayResource(store, project, environment);
  const label = input.deploymentId ?? r.projectId;
  return runGuarded(
    store,
    ctx(project, environment, "railway", "deploy", "create_railway_deployment", `deploy ${label}`, {
      resourceLabel: label,
    }),
    () => {
      const token = tokenFor(store, "railway", connectionId);
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
  const { r, connectionId } = railwayResource(store, project, environment);
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
      return rw.upsertVariable(tokenFor(store, "railway", connectionId), {
        projectId: r.projectId,
        environmentId: r.environmentId,
        serviceId: input.serviceId ?? r.serviceId,
        name: input.key,
        value: input.value,
        skipDeploys: input.skipDeploys,
      });
    },
  );
}

// --- Render ----------------------------------------------------------------

function renderResource(store: Store, project: Project, environment: Environment) {
  const m = requireMapping(store, project, environment, "render");
  return {
    r: m.resource as { serviceId: string; serviceName?: string; ownerId?: string },
    connectionId: m.connectionId,
  };
}

/**
 * Resolve the latest Render deploy (for status/URL) and fetch the mapped
 * service's logs. Render's logs endpoint is service-scoped (not deploy-scoped),
 * so `deploymentId` only picks which deploy's status is reported; the log lines
 * are the service's recent logs. Log-availability problems become a
 * `limitation` (with status attached) rather than a thrown error.
 */
async function fetchRenderLogsData(
  token: string,
  r: { serviceId: string; ownerId?: string },
  opts: { deploymentId?: string; since?: string; limit?: number },
): Promise<LogResult> {
  const limit = opts.limit ?? 100;
  const time_range = { since: opts.since };

  // The logs API needs an ownerId; resolve it from the service if not mapped.
  let ownerId = r.ownerId;
  let deployment_url: string | undefined;
  if (!ownerId) {
    try {
      const svc = await rd.getService(token, r.serviceId);
      ownerId = svc.ownerId;
      deployment_url = httpsUrl(svc.url);
    } catch {
      /* best-effort — continue without ownerId (logs may still be unavailable) */
    }
  }

  let deploymentId = opts.deploymentId;
  let deployment_status: string | undefined;
  if (!deploymentId) {
    try {
      const deps = await rd.listDeploys(token, r.serviceId, 1);
      if (deps.length > 0) {
        deploymentId = deps[0]!.id;
        deployment_status = deps[0]!.status;
      }
    } catch {
      /* best-effort */
    }
  }

  const resource = {
    service: r.serviceId,
    deployment_id: deploymentId,
    deployment_url,
    deployment_status,
  };

  if (!ownerId) {
    return {
      resource,
      time_range,
      logs: [],
      limitation:
        "Could not resolve the Render owner id required by the logs API. Add `ownerId` to the " +
        "render mapping, or ensure the API key can read the service.",
      audit_written: true,
    };
  }

  try {
    const raw = await rd.getLogs(token, ownerId, r.serviceId, limit, opts.since);
    const logs = raw.map(normalizeRenderLog);
    const limitation =
      logs.length === 0
        ? "Render returned no log lines for this service in the requested window."
        : undefined;
    return { resource, time_range, logs, limitation, audit_written: true };
  } catch (err) {
    return {
      resource,
      time_range,
      logs: [],
      limitation:
        `Could not fetch Render logs (${err instanceof Error ? err.message : String(err)}). ` +
        "Returning the deployment status only.",
      audit_written: true,
    };
  }
}

/** Shared guarded Render log read; `tool` distinguishes the audited entry. */
function runRenderLogs(
  store: Store,
  input: Base & { deploymentId?: string; since?: string; limit?: number },
  tool: string,
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const { r, connectionId } = renderResource(store, project, environment);
  const label = input.deploymentId ?? r.serviceId;
  return runGuarded(
    store,
    ctx(project, environment, "render", "read", tool, `logs ${label}`, { resourceLabel: label }),
    () =>
      fetchRenderLogsData(tokenFor(store, "render", connectionId), r, {
        deploymentId: input.deploymentId,
        since: input.since,
        limit: input.limit,
      }),
  );
}

/** get_render_logs — Render-specific; resolves the latest deploy if none given. */
export function renderLogs(
  store: Store,
  input: Base & { deploymentId?: string; since?: string; limit?: number },
): Promise<GuardedResponse> {
  return runRenderLogs(store, input, "get_render_logs");
}

/** get_render_service_context — the mapped Render service (type, URL, repo/branch). */
export async function renderServiceContext(store: Store, input: Base): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const { r, connectionId } = renderResource(store, project, environment);
  return runGuarded(
    store,
    ctx(project, environment, "render", "read", "get_render_service_context", `service ${r.serviceId}`, {
      resourceLabel: r.serviceId,
    }),
    () => rd.getService(tokenFor(store, "render", connectionId), r.serviceId),
  );
}

/** get_render_deployments — recent deploys for the mapped service. */
export async function renderDeployments(
  store: Store,
  input: Base & { limit?: number },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const { r, connectionId } = renderResource(store, project, environment);
  return runGuarded(
    store,
    ctx(project, environment, "render", "read", "get_render_deployments", `deploys ${r.serviceId}`, {
      resourceLabel: r.serviceId,
    }),
    () => rd.listDeploys(tokenFor(store, "render", connectionId), r.serviceId, input.limit ?? 10),
  );
}

/**
 * create_render_deployment — trigger a deploy of the mapped Render service.
 * PRODUCTION deploys require approval by default (capability "deploy").
 */
export async function renderCreateDeployment(
  store: Store,
  input: Base & { commitId?: string; clearCache?: boolean },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const { r, connectionId } = renderResource(store, project, environment);
  return runGuarded(
    store,
    ctx(project, environment, "render", "deploy", "create_render_deployment", `deploy ${r.serviceId}`, {
      resourceLabel: r.serviceId,
    }),
    () =>
      rd.triggerDeploy(tokenFor(store, "render", connectionId), r.serviceId, {
        commitId: input.commitId,
        clearCache: input.clearCache,
      }),
  );
}

/**
 * set_render_env_var — create/update a Render env var. PRODUCTION env changes
 * require approval by default (capability "env_change"). Render redeploys the
 * service on change.
 */
export async function renderSetEnvVar(
  store: Store,
  input: Base & { key: string; value: string },
): Promise<GuardedResponse> {
  const { project, environment } = resolve(store, input);
  const { r, connectionId } = renderResource(store, project, environment);
  return runGuarded(
    store,
    ctx(project, environment, "render", "env_change", "set_render_env_var", `set var ${input.key} on ${r.serviceId}`, {
      resourceLabel: `${r.serviceId}:${input.key}`,
    }),
    () => rd.upsertEnvVar(tokenFor(store, "render", connectionId), r.serviceId, input.key, input.value),
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
  if (provider === "render") {
    return runRenderLogs(store, base, "get_latest_deployment_logs");
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
    } else if (p === "render") {
      providers.push(await runRenderLogs(store, logInput, "get_app_logs"));
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
    () => sb.runQuery(tokenFor(store, "supabase", m.connectionId), r.projectRef, input.sql, classified.readOnly),
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
