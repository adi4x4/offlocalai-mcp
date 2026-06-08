import { httpJson } from "./http.js";

/**
 * GitHub REST adapter (read-only surface for V0).
 * Base: https://api.github.com — auth: Bearer PAT (GITHUB_TOKEN).
 * Pinned API version per research note.
 */
const BASE = "https://api.github.com";
const API_VERSION = "2026-03-10";

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": "offlocalai-mcp",
  };
}

export interface GithubRepoContext {
  fullName: string;
  description: string | null;
  defaultBranch: string;
  private: boolean;
  pushedAt: string;
  language: string | null;
  openIssues: number;
  topics?: string[];
  htmlUrl: string;
}

export async function getRepoContext(
  token: string,
  owner: string,
  repo: string,
): Promise<GithubRepoContext> {
  const data = await httpJson<Record<string, any>>(`${BASE}/repos/${owner}/${repo}`, {
    headers: headers(token),
  });
  return {
    fullName: data.full_name,
    description: data.description ?? null,
    defaultBranch: data.default_branch,
    private: data.private,
    pushedAt: data.pushed_at,
    language: data.language ?? null,
    openIssues: data.open_issues_count ?? 0,
    topics: data.topics,
    htmlUrl: data.html_url,
  };
}

export async function getReadme(
  token: string,
  owner: string,
  repo: string,
): Promise<{ path: string; content: string }> {
  const data = await httpJson<Record<string, any>>(`${BASE}/repos/${owner}/${repo}/readme`, {
    headers: headers(token),
  });
  const decoded =
    data.encoding === "base64"
      ? Buffer.from(data.content, "base64").toString("utf8")
      : String(data.content ?? "");
  return { path: data.path, content: decoded };
}

export interface GithubFileEntry {
  name: string;
  path: string;
  type: string;
  size: number;
}

export async function listFiles(
  token: string,
  owner: string,
  repo: string,
  path = "",
): Promise<GithubFileEntry[]> {
  const data = await httpJson<any>(
    `${BASE}/repos/${owner}/${repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`,
    { headers: headers(token) },
  );
  const arr = Array.isArray(data) ? data : [data];
  return arr.map((e: Record<string, any>) => ({
    name: e.name,
    path: e.path,
    type: e.type,
    size: e.size ?? 0,
  }));
}
