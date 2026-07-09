import type { Store } from "./storage.js";
import { resolveProject, resolveEnvironment, findMapping, requireMapping } from "./resolve.js";
import {
  tokenFor,
  vercelTeamId,
  vercelCreateDeployment,
  railwayCreateDeployment,
  renderCreateDeployment,
  vercelLogs,
  railwayLogs,
  renderLogs,
} from "./provider-actions.js";
import type { GuardedResponse } from "./actions.js";
import * as vc from "./providers/vercel.js";
import * as rw from "./providers/railway.js";
import * as rd from "./providers/render.js";
import type { Environment, Project, ProviderId } from "./types.js";
import { OfflocalError } from "./util.js";

/**
 * The unified deploy interface — the "vibe-deployment" entry point.
 *
 * `deploy(project, environment)` is all an agent needs: it resolves which
 * provider owns the environment's deploys, triggers the deployment THROUGH the
 * normal guarded action (so policy + audit still apply — production still asks
 * for approval, everything is still logged), then polls until the deployment
 * reaches a terminal state and returns the live URL — or, on failure, a tail of
 * the logs so the agent can fix and redeploy without a second round-trip.
 *
 * There is no provider-specific ceremony: the agent says "deploy", offlocal
 * figures out where and reports back what happened.
 */

/** Providers that can deploy, in the priority order used when one isn't specified. */
const DEPLOY_PROVIDERS: ProviderId[] = ["vercel", "railway", "render"];

type DeployPhase = "success" | "failed" | "in_progress" | "unknown";

interface DeployStatus {
  phase: DeployPhase;
  state: string;
  url?: string;
  errorMessage?: string;
}

export interface DeployInput {
  project?: string;
  environment: string;
  /** Force a specific deploy provider when more than one is mapped. */
  provider?: ProviderId;
  /** Wait for the deployment to finish (default true). If false, returns as soon as it's triggered. */
  wait?: boolean;
  /** Max seconds to wait for a terminal state (default 180). */
  timeoutSeconds?: number;
  /** Seconds between status polls (default 3). */
  pollIntervalSeconds?: number;
  /** Vercel/Render: deploy a specific git commit. */
  commitId?: string;
  /** Vercel: redeploy an existing deployment by id. */
  deploymentId?: string;
}

export interface DeployResult {
  status:
    | "deployed"
    | "failed"
    | "deploying"
    | "timeout"
    | "approval_required"
    | "blocked"
    | "error";
  project: string;
  environment: string;
  provider: ProviderId;
  deploymentId?: string;
  url?: string;
  state?: string;
  message: string;
  /** Present on failure: a tail of the deployment's log lines. */
  logs?: Array<{ timestamp: string; level: string; message: string }>;
  /** Present on approval_required / blocked / error: how to proceed. */
  reason?: string;
  suggested_next_step?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Which deploy-capable provider owns this environment's deploys? */
function resolveDeployProvider(
  store: Store,
  environment: Environment,
  explicit?: ProviderId,
): ProviderId {
  const mapped = DEPLOY_PROVIDERS.filter((p) => !!findMapping(store, environment, p));
  if (explicit) {
    if (!DEPLOY_PROVIDERS.includes(explicit)) {
      throw new OfflocalError(`Provider "${explicit}" cannot deploy. Deployable: ${DEPLOY_PROVIDERS.join(", ")}.`);
    }
    if (!mapped.includes(explicit)) {
      throw new OfflocalError(
        `No ${explicit} mapping for ${environment.name}. Map one with map_provider_resource, or omit \`provider\`.`,
      );
    }
    return explicit;
  }
  if (mapped.length === 0) {
    throw new OfflocalError(
      `No deployable provider is mapped to ${environment.name}. Map a Vercel, Railway, or Render ` +
        `resource with map_provider_resource first.`,
    );
  }
  if (mapped.length > 1) {
    throw new OfflocalError(
      `${environment.name} has multiple deploy targets (${mapped.join(", ")}). ` +
        `Pass \`provider\` to pick one.`,
    );
  }
  return mapped[0]!;
}

/** Trigger the deploy through the guarded action and pull out the new deployment id. */
async function triggerDeploy(
  store: Store,
  provider: ProviderId,
  input: DeployInput,
): Promise<{ guard: GuardedResponse; deploymentId?: string }> {
  const base = { project: input.project, environment: input.environment };
  if (provider === "vercel") {
    const guard = await vercelCreateDeployment(store, { ...base, deploymentId: input.deploymentId });
    const data = guard.status === "ok" ? (guard.data as Record<string, any>) : undefined;
    return { guard, deploymentId: data?.id ?? data?.uid };
  }
  if (provider === "railway") {
    const guard = await railwayCreateDeployment(store, { ...base, deploymentId: input.deploymentId });
    const data = guard.status === "ok" ? (guard.data as Record<string, any>) : undefined;
    return { guard, deploymentId: data?.deploymentId ?? data?.id };
  }
  // render
  const guard = await renderCreateDeployment(store, { ...base, commitId: input.commitId });
  const data = guard.status === "ok" ? (guard.data as Record<string, any>) : undefined;
  return { guard, deploymentId: data?.id };
}

const VERCEL_FAIL = new Set(["ERROR", "CANCELED"]);
const RAILWAY_FAIL = new Set(["FAILED", "CRASHED", "REMOVED", "SKIPPED"]);
const RENDER_FAIL = new Set([
  "build_failed",
  "update_failed",
  "pre_deploy_failed",
  "canceled",
  "deactivated",
]);

/** Read the current status of a deployment (best-effort, not audited — like the context snapshot). */
async function describeDeployment(
  store: Store,
  provider: ProviderId,
  project: Project,
  environment: Environment,
  deploymentId: string,
): Promise<DeployStatus> {
  if (provider === "vercel") {
    const m = requireMapping(store, project, environment, "vercel");
    const r = m.resource as { projectId: string; teamId?: string };
    const token = tokenFor(store, "vercel", m.connectionId);
    const s = await vc.getDeploymentStatus(token, deploymentId, vercelTeamId(store, r.teamId, m.connectionId));
    const state = String(s.readyState ?? s.status ?? "UNKNOWN");
    const phase: DeployPhase = state === "READY" ? "success" : VERCEL_FAIL.has(state) ? "failed" : "in_progress";
    return {
      phase,
      state,
      url: typeof s.url === "string" ? `https://${s.url}` : undefined,
      errorMessage: typeof s.errorMessage === "string" ? s.errorMessage : undefined,
    };
  }
  if (provider === "railway") {
    const token = tokenFor(store, "railway", findMapping(store, environment, "railway")?.connectionId);
    const d = await rw.getDeployment(token, deploymentId);
    if (!d) return { phase: "unknown", state: "UNKNOWN" };
    const state = String(d.status ?? "UNKNOWN").toUpperCase();
    const phase: DeployPhase = state === "SUCCESS" ? "success" : RAILWAY_FAIL.has(state) ? "failed" : "in_progress";
    const bare = d.staticUrl ?? d.url;
    return { phase, state, url: bare ? (/^https?:\/\//i.test(bare) ? bare : `https://${bare}`) : undefined };
  }
  // render
  const m = requireMapping(store, project, environment, "render");
  const r = m.resource as { serviceId: string };
  const token = tokenFor(store, "render", m.connectionId);
  const d = await rd.getDeploy(token, r.serviceId, deploymentId);
  const state = String(d.status ?? "unknown");
  const phase: DeployPhase = state === "live" ? "success" : RENDER_FAIL.has(state) ? "failed" : "in_progress";
  let url: string | undefined;
  if (phase === "success") {
    try {
      url = (await rd.getService(token, r.serviceId)).url;
    } catch {
      /* best-effort */
    }
  }
  return { phase, state, url };
}

/** Fetch a short tail of logs for a failed deployment (reuses the audited log readers). */
async function failureLogs(
  store: Store,
  provider: ProviderId,
  input: DeployInput,
  deploymentId: string,
): Promise<DeployResult["logs"]> {
  const base = { project: input.project, environment: input.environment, deploymentId, limit: 40 };
  try {
    const res =
      provider === "vercel"
        ? await vercelLogs(store, base)
        : provider === "railway"
          ? await railwayLogs(store, base)
          : await renderLogs(store, base);
    if (res.status === "ok") {
      const logs = (res.data as any)?.logs;
      if (Array.isArray(logs)) return logs.slice(-40);
    }
  } catch {
    /* best-effort — the failure result stands on its own */
  }
  return undefined;
}

export async function deploy(store: Store, input: DeployInput): Promise<DeployResult> {
  const project = resolveProject(store, input.project);
  const environment = resolveEnvironment(store, project, input.environment);
  const provider = resolveDeployProvider(store, environment, input.provider);

  const base = {
    project: project.slug,
    environment: environment.name,
    provider,
  };

  const { guard, deploymentId } = await triggerDeploy(store, provider, input);

  // Policy said no (production approval / block) or the trigger errored — surface it as-is.
  if (guard.status !== "ok") {
    const g = guard as any;
    return {
      ...base,
      status: guard.status,
      deploymentId,
      message:
        guard.status === "approval_required"
          ? `Deploy to ${environment.name} needs approval before it runs.`
          : guard.status === "blocked"
            ? `Deploy to ${environment.name} is blocked by policy.`
            : `Deploy could not be triggered: ${g.error ?? "unknown error"}.`,
      reason: g.reason,
      suggested_next_step: g.suggested_next_step,
    };
  }

  if (!deploymentId) {
    return {
      ...base,
      status: "deploying",
      message:
        `Deploy to ${environment.name} was triggered on ${provider}, but no deployment id was returned — ` +
        `check status with get_${provider === "vercel" ? "vercel" : provider}_deployments.`,
    };
  }

  if (input.wait === false) {
    return {
      ...base,
      status: "deploying",
      deploymentId,
      message: `Deploy to ${environment.name} triggered on ${provider} (deployment ${deploymentId}). Not waiting for completion.`,
    };
  }

  // Poll until terminal or timeout. First check happens immediately (no initial sleep),
  // so a deployment that is already terminal returns without any delay.
  const timeoutMs = Math.max(1, input.timeoutSeconds ?? 180) * 1000;
  const intervalMs = Math.max(1, input.pollIntervalSeconds ?? 3) * 1000;
  const deadline = Date.now() + timeoutMs;
  let last: DeployStatus = { phase: "in_progress", state: "PENDING" };

  while (Date.now() < deadline) {
    try {
      last = await describeDeployment(store, provider, project, environment, deploymentId);
    } catch (err) {
      // Transient read error — report the last known state rather than failing the whole deploy.
      last = { phase: "unknown", state: "UNKNOWN", errorMessage: err instanceof Error ? err.message : String(err) };
    }
    if (last.phase === "success") {
      return {
        ...base,
        status: "deployed",
        deploymentId,
        url: last.url,
        state: last.state,
        message: last.url
          ? `Deployed ${project.slug} to ${environment.name} on ${provider}. Live at ${last.url}.`
          : `Deployed ${project.slug} to ${environment.name} on ${provider} (${last.state}).`,
      };
    }
    if (last.phase === "failed") {
      const logs = await failureLogs(store, provider, input, deploymentId);
      return {
        ...base,
        status: "failed",
        deploymentId,
        state: last.state,
        message:
          `Deploy of ${project.slug} to ${environment.name} on ${provider} failed (${last.state}).` +
          (last.errorMessage ? ` ${last.errorMessage}` : ""),
        logs,
      };
    }
    if (Date.now() + intervalMs < deadline) await delay(intervalMs);
    else break;
  }

  return {
    ...base,
    status: "timeout",
    deploymentId,
    state: last.state,
    message:
      `Deploy to ${environment.name} on ${provider} is still ${last.state} after ` +
      `${input.timeoutSeconds ?? 180}s. It may still finish — check get_${provider}_deployments or get_deploy_status.`,
  };
}

/** get_deploy_status — check the current status/URL of a deployment without triggering one. */
export async function deployStatus(
  store: Store,
  input: { project?: string; environment: string; provider?: ProviderId; deploymentId: string },
): Promise<DeployResult> {
  const project = resolveProject(store, input.project);
  const environment = resolveEnvironment(store, project, input.environment);
  const provider = resolveDeployProvider(store, environment, input.provider);
  const s = await describeDeployment(store, provider, project, environment, input.deploymentId);
  const status: DeployResult["status"] =
    s.phase === "success" ? "deployed" : s.phase === "failed" ? "failed" : "deploying";
  return {
    project: project.slug,
    environment: environment.name,
    provider,
    deploymentId: input.deploymentId,
    status,
    state: s.state,
    url: s.url,
    message: `Deployment ${input.deploymentId} on ${provider} is ${s.state}.`,
  };
}
