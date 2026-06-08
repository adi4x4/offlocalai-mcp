import { httpJson } from "./http.js";

/**
 * Supabase Management API adapter.
 * Base: https://api.supabase.com/v1 — auth: Bearer PAT (SUPABASE_ACCESS_TOKEN).
 *
 * SQL runs via POST /v1/projects/{ref}/database/query with { query, read_only }.
 * `read_only: true` is the REAL enforcement for reads (backend runs as a
 * read-only Postgres user); our local SQL classification is defense-in-depth.
 */
const BASE = "https://api.supabase.com/v1";

function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

export interface SupabaseProject {
  id: string;
  ref?: string;
  name: string;
  region?: string;
  status?: string;
  organizationId?: string;
}

export async function listProjects(token: string): Promise<SupabaseProject[]> {
  const data = await httpJson<any[]>(`${BASE}/projects`, { headers: headers(token) });
  return (data ?? []).map((p: Record<string, any>) => ({
    id: p.id,
    ref: p.ref ?? p.id,
    name: p.name,
    region: p.region,
    status: p.status,
    organizationId: p.organization_id,
  }));
}

export async function getProject(token: string, ref: string): Promise<SupabaseProject> {
  const p = await httpJson<Record<string, any>>(`${BASE}/projects/${ref}`, {
    headers: headers(token),
  });
  return {
    id: p.id,
    ref: p.ref ?? ref,
    name: p.name,
    region: p.region,
    status: p.status,
    organizationId: p.organization_id,
  };
}

/**
 * Run SQL against a project. `readOnly` is passed through to the backend.
 * Returns the result rows (shape depends on the query).
 */
export async function runQuery(
  token: string,
  ref: string,
  query: string,
  readOnly: boolean,
): Promise<unknown> {
  return httpJson<unknown>(`${BASE}/projects/${ref}/database/query`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ query, read_only: readOnly }),
  });
}
