import { httpJson } from "./http.js";

/**
 * Vercel REST adapter. Base: https://api.vercel.com — auth: Bearer VERCEL_TOKEN.
 * Note the mixed API versions per endpoint (v3/v7/v9/v10/v13) — see research note.
 * `teamId` must be threaded onto every request for team-owned resources.
 */
const BASE = "https://api.vercel.com";

function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function teamQuery(teamId?: string): Record<string, string | undefined> {
  return { teamId };
}

export interface VercelProjectContext {
  id: string;
  name: string;
  framework: string | null;
  latestDeployments?: number;
  createdAt?: number;
}

export async function getProjectContext(
  token: string,
  idOrName: string,
  teamId?: string,
): Promise<VercelProjectContext> {
  const data = await httpJson<Record<string, any>>(`${BASE}/v9/projects/${idOrName}`, {
    headers: headers(token),
    query: teamQuery(teamId),
  });
  return {
    id: data.id,
    name: data.name,
    framework: data.framework ?? null,
    latestDeployments: Array.isArray(data.latestDeployments)
      ? data.latestDeployments.length
      : undefined,
    createdAt: data.createdAt,
  };
}

export interface VercelDeployment {
  uid: string;
  name: string;
  url: string;
  state: string;
  readyState: string;
  target: string | null;
  createdAt: number;
}

export async function listDeployments(
  token: string,
  projectId: string,
  teamId?: string,
  limit = 10,
): Promise<VercelDeployment[]> {
  const data = await httpJson<{ deployments?: any[] }>(`${BASE}/v7/deployments`, {
    headers: headers(token),
    query: { ...teamQuery(teamId), projectId, limit: String(limit) },
  });
  return (data.deployments ?? []).map((d: Record<string, any>) => ({
    uid: d.uid,
    name: d.name,
    url: d.url,
    state: d.state ?? d.readyState,
    readyState: d.readyState ?? d.state,
    target: d.target ?? null,
    createdAt: d.created ?? d.createdAt,
  }));
}

export async function getDeploymentStatus(
  token: string,
  idOrUrl: string,
  teamId?: string,
): Promise<Record<string, unknown>> {
  const d = await httpJson<Record<string, any>>(`${BASE}/v13/deployments/${idOrUrl}`, {
    headers: headers(token),
    query: teamQuery(teamId),
  });
  return {
    uid: d.id ?? d.uid,
    url: d.url,
    readyState: d.readyState ?? d.status,
    readySubstate: d.readySubstate,
    target: d.target ?? null,
    errorCode: d.errorCode,
    errorMessage: d.errorMessage,
    createdAt: d.createdAt ?? d.created,
  };
}

export interface VercelLogEvent {
  type: string;
  created: number;
  text?: string;
}

export async function getDeploymentLogs(
  token: string,
  idOrUrl: string,
  teamId?: string,
  limit = 100,
  since?: number,
): Promise<VercelLogEvent[]> {
  const data = await httpJson<any>(`${BASE}/v3/deployments/${idOrUrl}/events`, {
    headers: headers(token),
    query: {
      ...teamQuery(teamId),
      limit: String(limit),
      builds: "1",
      since: since !== undefined ? String(since) : undefined,
    },
  });
  const arr = Array.isArray(data) ? data : (data?.events ?? []);
  return arr.map((e: Record<string, any>) => ({
    type: e.type,
    created: e.created ?? e.date,
    text: e.text ?? e.payload?.text,
  }));
}

export async function setEnvVar(
  token: string,
  projectId: string,
  params: { key: string; value: string; target: string[]; type?: string },
  teamId?: string,
): Promise<Record<string, unknown>> {
  return httpJson<Record<string, unknown>>(`${BASE}/v10/projects/${projectId}/env`, {
    method: "POST",
    headers: { ...headers(token), "Content-Type": "application/json" },
    query: { ...teamQuery(teamId), upsert: "true" },
    body: JSON.stringify({
      key: params.key,
      value: params.value,
      type: params.type ?? "encrypted",
      target: params.target,
    }),
  });
}

export async function createDeployment(
  token: string,
  params: { name: string; project: string; target?: string; deploymentId?: string },
  teamId?: string,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    name: params.name,
    project: params.project,
    target: params.target ?? "preview",
  };
  if (params.deploymentId) body.deploymentId = params.deploymentId;
  return httpJson<Record<string, unknown>>(`${BASE}/v13/deployments`, {
    method: "POST",
    headers: { ...headers(token), "Content-Type": "application/json" },
    query: teamQuery(teamId),
    body: JSON.stringify(body),
  });
}
