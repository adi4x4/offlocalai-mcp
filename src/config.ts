import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { Store } from "./storage.js";
import {
  addEnvironment,
  createProject,
  mapProviderResource,
  setPolicyRule,
  writeProjectMemory,
} from "./service.js";
import type { Capability, EnvironmentKind, PolicyRule, ProviderId, ProviderResource } from "./types.js";

/**
 * Declarative config (`.offlocal/config.yaml`) — the file that sells the mental
 * model. It maps projects → environments → provider resources, and declares
 * policy as `require_approval` / `block` lists. `offlocal init` seeds the
 * runtime state (state.json) from it; state.json remains the source of truth.
 * Seeding skips projects whose slug already exists, so re-running is safe.
 *
 * Format:
 *   projects:
 *     your-project:
 *       environments:
 *         staging:
 *           github:   { repo: your-org/your-repo }
 *           vercel:   { project: your-staging-vercel-project }
 *           supabase: { project_ref: your_staging_project_ref }
 *           stripe:   { mode: test }
 *   policy:
 *     require_approval: [ vercel.deploy, vercel.env.write, supabase.write, stripe.write ]
 *     block:            [ supabase.destructive_sql, provider.delete ]
 */

interface ConfigEnvironment {
  kind?: EnvironmentKind;
  github?: { repo: string };
  vercel?: { project: string; team_id?: string };
  supabase?: { project_ref: string };
  stripe?: { mode: "test" | "live" };
  railway?: { project_id: string; environment_id?: string; service_id?: string };
}

interface ConfigMemory {
  environment?: string;
  note: string;
  tags?: string[];
}

interface ConfigProject {
  name?: string;
  description?: string;
  environments?: Record<string, ConfigEnvironment>;
  memory?: ConfigMemory[];
}

interface OfflocalConfig {
  projects?: Record<string, ConfigProject>;
  policy?: {
    require_approval?: string[];
    block?: string[];
  };
}

export function loadConfig(path: string): OfflocalConfig | undefined {
  if (!existsSync(path)) return undefined;
  return (parseYaml(readFileSync(path, "utf8")) ?? {}) as OfflocalConfig;
}

/** Map a dotted policy token (e.g. "vercel.env.write") to a rule match. */
function tokenToMatch(token: string): { provider?: ProviderId; capability: Capability } | null {
  const parts = token.trim().split(".");
  const head = parts[0]!;
  const rest = parts.slice(1).join(".");
  const provider: ProviderId | undefined =
    head === "provider" || head === "*" ? undefined : (head as ProviderId);

  const capByToken: Record<string, Capability> = {
    deploy: "deploy",
    "env.write": "env_change",
    env_change: "env_change",
    write: "write",
    destructive_sql: "destructive_sql",
    delete: "delete",
    read: "read",
  };
  // For "provider.delete" the action token is "delete"; for "vercel.deploy" it's "deploy".
  const capability = capByToken[rest] ?? capByToken[head];
  if (!capability) return null;
  return { provider, capability };
}

function environmentResource(provider: ProviderId, env: ConfigEnvironment): ProviderResource | null {
  switch (provider) {
    case "github": {
      if (!env.github) return null;
      const [owner, repo] = env.github.repo.split("/");
      if (!owner || !repo) return null;
      return { provider, owner, repo };
    }
    case "vercel":
      return env.vercel ? { provider, projectId: env.vercel.project, teamId: env.vercel.team_id } : null;
    case "supabase":
      return env.supabase ? { provider, projectRef: env.supabase.project_ref } : null;
    case "stripe":
      return env.stripe ? { provider, mode: env.stripe.mode } : null;
    case "railway":
      return env.railway
        ? {
            provider,
            projectId: env.railway.project_id,
            environmentId: env.railway.environment_id,
            serviceId: env.railway.service_id,
          }
        : null;
  }
}

export interface SeedResult {
  createdProjects: string[];
  skippedProjects: string[];
  createdRules: number;
}

export function applyConfig(store: Store, config: OfflocalConfig): SeedResult {
  const result: SeedResult = { createdProjects: [], skippedProjects: [], createdRules: 0 };
  const providers: ProviderId[] = ["github", "vercel", "supabase", "stripe", "railway"];

  for (const [slug, p] of Object.entries(config.projects ?? {})) {
    if (store.data.projects.some((x) => x.slug === slug)) {
      result.skippedProjects.push(slug);
      continue;
    }
    const project = createProject(store, { name: p.name ?? slug, slug, description: p.description });
    result.createdProjects.push(project.slug);

    for (const [envName, envCfg] of Object.entries(p.environments ?? {})) {
      addEnvironment(store, { project: project.slug, name: envName, kind: envCfg.kind });
      for (const provider of providers) {
        const resource = environmentResource(provider, envCfg);
        if (!resource) continue;
        mapProviderResource(store, { project: project.slug, environment: envName, provider, resource });
      }
    }

    for (const m of p.memory ?? []) {
      writeProjectMemory(store, {
        project: project.slug,
        environment: m.environment,
        note: m.note,
        tags: m.tags,
      });
    }
  }

  // Policy: require_approval → approval scoped to production; block → block everywhere.
  // (Staging/dev keep the permissive built-in defaults, so test/staging stays usable.)
  for (const token of config.policy?.require_approval ?? []) {
    const match = tokenToMatch(token);
    if (!match) continue;
    setPolicyRule(store, {
      effect: "approval_required",
      priority: 100,
      description: `config: require approval for ${token} in production`,
      match: { ...match, environmentKind: "production" } as PolicyRule["match"],
    });
    result.createdRules += 1;
  }
  for (const token of config.policy?.block ?? []) {
    const match = tokenToMatch(token);
    if (!match) continue;
    setPolicyRule(store, {
      effect: "block",
      priority: 150,
      description: `config: block ${token} everywhere`,
      match: match as PolicyRule["match"],
    });
    result.createdRules += 1;
  }

  return result;
}

export function seedFromConfigFile(store: Store, path: string): SeedResult | undefined {
  const config = loadConfig(path);
  if (!config) return undefined;
  return applyConfig(store, config);
}
