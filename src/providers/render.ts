import { httpJson } from "./http.js";

/**
 * Render REST adapter. Base: https://api.render.com/v1 — auth is
 * `Authorization: Bearer <RENDER_API_KEY>`.
 *
 * Render's resource model is owner (workspace) → service → deploy. A mapping
 * carries a serviceId; the ownerId is only needed for the logs endpoint and is
 * resolved from the service when absent. List endpoints wrap each item in an
 * object with a `cursor`, e.g. `[{ deploy: {...}, cursor }]`; single-resource
 * reads return the object directly.
 */
const BASE = "https://api.render.com/v1";

function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: "application/json" };
}

export interface RenderService {
  id: string;
  name: string;
  type: string;
  ownerId?: string;
  /** Public URL for web services / static sites; absent for workers, cron jobs, private services. */
  url?: string;
  suspended?: string;
  branch?: string;
  repo?: string;
}

/** GET /services/{id} — the service, with its public URL flattened out of serviceDetails. */
export async function getService(token: string, serviceId: string): Promise<RenderService> {
  const s = await httpJson<Record<string, any>>(`${BASE}/services/${serviceId}`, {
    headers: headers(token),
  });
  return {
    id: s.id,
    name: s.name,
    type: s.type,
    ownerId: s.ownerId,
    url: s.serviceDetails?.url ?? undefined,
    suspended: s.suspended,
    branch: s.branch,
    repo: s.repo,
  };
}

export interface RenderDeploy {
  id: string;
  status: string;
  commitId?: string;
  commitMessage?: string;
  createdAt?: string;
  finishedAt?: string;
}

function normalizeDeploy(d: Record<string, any>): RenderDeploy {
  return {
    id: d.id,
    status: d.status,
    commitId: d.commit?.id,
    commitMessage: d.commit?.message,
    createdAt: d.createdAt,
    finishedAt: d.finishedAt ?? undefined,
  };
}

/** GET /services/{id}/deploys — recent deploys, newest first. */
export async function listDeploys(
  token: string,
  serviceId: string,
  limit = 10,
): Promise<RenderDeploy[]> {
  const data = await httpJson<any[]>(`${BASE}/services/${serviceId}/deploys`, {
    headers: headers(token),
    query: { limit: String(limit) },
  });
  const arr = Array.isArray(data) ? data : [];
  return arr.map((item) => normalizeDeploy(item.deploy ?? item));
}

/** GET /services/{id}/deploys/{deployId} — a single deploy (used for polling status). */
export async function getDeploy(
  token: string,
  serviceId: string,
  deployId: string,
): Promise<RenderDeploy> {
  const d = await httpJson<Record<string, any>>(
    `${BASE}/services/${serviceId}/deploys/${deployId}`,
    { headers: headers(token) },
  );
  return normalizeDeploy(d);
}

/** POST /services/{id}/deploys — trigger a deploy (optionally at a commit / clearing cache). */
export async function triggerDeploy(
  token: string,
  serviceId: string,
  opts: { commitId?: string; clearCache?: boolean } = {},
): Promise<RenderDeploy> {
  const body: Record<string, unknown> = {};
  if (opts.commitId) body.commitId = opts.commitId;
  if (opts.clearCache) body.clearCache = "clear";
  const d = await httpJson<Record<string, any>>(`${BASE}/services/${serviceId}/deploys`, {
    method: "POST",
    headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return normalizeDeploy(d);
}

export interface RenderLog {
  timestamp?: string;
  message?: string;
  level?: string;
}

/**
 * GET /logs — Render's unified logs endpoint. Requires the owner id and the
 * resource id (the service). Returns the collection under `logs`.
 */
export async function getLogs(
  token: string,
  ownerId: string,
  serviceId: string,
  limit = 100,
  startTime?: string,
): Promise<RenderLog[]> {
  const data = await httpJson<{ logs?: any[] }>(`${BASE}/logs`, {
    headers: headers(token),
    query: {
      ownerId,
      resource: serviceId,
      limit: String(limit),
      startTime,
    },
  });
  return (data.logs ?? []).map((l: Record<string, any>) => ({
    timestamp: l.timestamp,
    message: l.message,
    level: l.level,
  }));
}

/** PUT /services/{id}/env-vars/{key} — upsert a single environment variable. */
export async function upsertEnvVar(
  token: string,
  serviceId: string,
  key: string,
  value: string,
): Promise<Record<string, unknown>> {
  return httpJson<Record<string, unknown>>(
    `${BASE}/services/${serviceId}/env-vars/${encodeURIComponent(key)}`,
    {
      method: "PUT",
      headers: { ...headers(token), "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    },
  );
}
