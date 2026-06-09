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
import { OfflocalError } from "./util.js";

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
  github?: { repo: string; connection_id?: string };
  vercel?: { project: string; team_id?: string; connection_id?: string };
  supabase?: { project_ref: string; connection_id?: string };
  stripe?: { mode: "test" | "live"; connection_id?: string };
  railway?: { project_id: string; environment_id?: string; service_id?: string; connection_id?: string };
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
  const parsed = parseYaml(readFileSync(path, "utf8")) ?? {};
  return validateConfig(parsed);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalObject(value: unknown, field: string): void {
  if (value !== undefined && !isPlainObject(value)) {
    throw new OfflocalError(`Invalid config: ${field} must be an object.`);
  }
}

function optionalStringArray(value: unknown, field: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new OfflocalError(`Invalid config: ${field} must be an array of strings.`);
  }
}

function optionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new OfflocalError(`Invalid config: ${field} must be a string.`);
  }
}

function requiredString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OfflocalError(`Invalid config: ${field} must be a non-empty string.`);
  }
}

function optionalConnectionId(value: unknown, field: string): void {
  if (value !== undefined && (typeof value !== "string" || value.trim().length === 0)) {
    throw new OfflocalError(`Invalid config: ${field} must be a non-empty string when provided.`);
  }
}

function validateProviderBlock(value: unknown, field: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new OfflocalError(`Invalid config: ${field} must be an object.`);
  }
  optionalConnectionId(value.connection_id, `${field}.connection_id`);
  return value;
}

function validateEnvironmentConfig(value: unknown, field: string): void {
  if (!isPlainObject(value)) {
    throw new OfflocalError(`Invalid config: ${field} must be an object.`);
  }
  if (value.kind !== undefined && value.kind !== "development" && value.kind !== "staging" && value.kind !== "production") {
    throw new OfflocalError(`Invalid config: ${field}.kind must be development, staging, or production.`);
  }

  const github = validateProviderBlock(value.github, `${field}.github`);
  if (github) requiredString(github.repo, `${field}.github.repo`);

  const vercel = validateProviderBlock(value.vercel, `${field}.vercel`);
  if (vercel) {
    requiredString(vercel.project, `${field}.vercel.project`);
    optionalString(vercel.team_id, `${field}.vercel.team_id`);
  }

  const supabase = validateProviderBlock(value.supabase, `${field}.supabase`);
  if (supabase) requiredString(supabase.project_ref, `${field}.supabase.project_ref`);

  const stripe = validateProviderBlock(value.stripe, `${field}.stripe`);
  if (stripe && stripe.mode !== "test" && stripe.mode !== "live") {
    throw new OfflocalError(`Invalid config: ${field}.stripe.mode must be "test" or "live".`);
  }

  const railway = validateProviderBlock(value.railway, `${field}.railway`);
  if (railway) {
    requiredString(railway.project_id, `${field}.railway.project_id`);
    optionalString(railway.environment_id, `${field}.railway.environment_id`);
    optionalString(railway.service_id, `${field}.railway.service_id`);
  }
}

function validateMemoryConfig(value: unknown, field: string): void {
  if (!isPlainObject(value)) {
    throw new OfflocalError(`Invalid config: ${field} must be an object.`);
  }
  optionalString(value.environment, `${field}.environment`);
  requiredString(value.note, `${field}.note`);
  optionalStringArray(value.tags, `${field}.tags`);
}

function validateProjectConfig(value: unknown, slug: string): void {
  if (!isPlainObject(value)) {
    throw new OfflocalError(`Invalid config: projects.${slug} must be an object.`);
  }
  optionalString(value.name, `projects.${slug}.name`);
  optionalString(value.description, `projects.${slug}.description`);
  optionalObject(value.environments, `projects.${slug}.environments`);
  if (value.memory !== undefined && !Array.isArray(value.memory)) {
    throw new OfflocalError(`Invalid config: projects.${slug}.memory must be an array.`);
  }
  if (isPlainObject(value.environments)) {
    for (const [envName, env] of Object.entries(value.environments)) {
      validateEnvironmentConfig(env, `projects.${slug}.environments.${envName}`);
    }
  }
  if (Array.isArray(value.memory)) {
    value.memory.forEach((entry, index) => {
      validateMemoryConfig(entry, `projects.${slug}.memory[${index}]`);
    });
  }
}

function validateConfig(value: unknown): OfflocalConfig {
  if (!isPlainObject(value)) {
    throw new OfflocalError("Invalid config: top-level config must be an object.");
  }
  optionalObject(value.projects, "projects");
  optionalObject(value.policy, "policy");
  if (isPlainObject(value.policy)) {
    optionalStringArray(value.policy.require_approval, "policy.require_approval");
    optionalStringArray(value.policy.block, "policy.block");
  }
  if (isPlainObject(value.projects)) {
    for (const [slug, project] of Object.entries(value.projects)) {
      validateProjectConfig(project, slug);
    }
  }
  for (const token of [
    ...(isPlainObject(value.policy) && Array.isArray(value.policy.require_approval) ? value.policy.require_approval : []),
    ...(isPlainObject(value.policy) && Array.isArray(value.policy.block) ? value.policy.block : []),
  ]) {
    if (!tokenToMatch(token)) {
      throw new OfflocalError(`Unknown policy token in config: ${token}.`);
    }
  }
  return value as OfflocalConfig;
}

/** Map a dotted policy token (e.g. "vercel.env.write") to a rule match. */
function tokenToMatch(token: string): { provider?: ProviderId; capability: Capability } | null {
  const parts = token.trim().split(".");
  const head = parts[0]!;
  const rest = parts.slice(1).join(".");
  const knownProviders: ProviderId[] = ["github", "vercel", "supabase", "stripe", "railway"];
  if (head !== "provider" && head !== "*" && !knownProviders.includes(head as ProviderId)) {
    return null;
  }
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
      if (!owner || !repo) {
        throw new OfflocalError(
          `Invalid github repo "${env.github.repo}" in config; expected owner/repo.`,
        );
      }
      return { provider, owner, repo };
    }
    case "vercel":
      if (!env.vercel) return null;
      if (!env.vercel.project?.trim()) {
        throw new OfflocalError("Invalid vercel project in config; expected a non-empty project id/name.");
      }
      return { provider, projectId: env.vercel.project, teamId: env.vercel.team_id };
    case "supabase":
      if (!env.supabase) return null;
      if (!env.supabase.project_ref?.trim()) {
        throw new OfflocalError("Invalid supabase project_ref in config; expected a non-empty project ref.");
      }
      return { provider, projectRef: env.supabase.project_ref };
    case "stripe":
      return env.stripe ? { provider, mode: env.stripe.mode } : null;
    case "railway":
      if (!env.railway) return null;
      if (!env.railway.project_id?.trim()) {
        throw new OfflocalError("Invalid railway project_id in config; expected a non-empty project id.");
      }
      return {
        provider,
        projectId: env.railway.project_id,
        environmentId: env.railway.environment_id,
        serviceId: env.railway.service_id,
      };
  }
}

function environmentConnectionId(provider: ProviderId, env: ConfigEnvironment): string | undefined {
  switch (provider) {
    case "github":
      return env.github?.connection_id;
    case "vercel":
      return env.vercel?.connection_id;
    case "supabase":
      return env.supabase?.connection_id;
    case "stripe":
      return env.stripe?.connection_id;
    case "railway":
      return env.railway?.connection_id;
  }
}

export interface SeedResult {
  createdProjects: string[];
  skippedProjects: string[];
  createdRules: number;
}

export function applyConfig(store: Store, config: OfflocalConfig): SeedResult {
  validateConfig(config);
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
        mapProviderResource(store, {
          project: project.slug,
          environment: envName,
          provider,
          connectionId: environmentConnectionId(provider, envCfg),
          resource,
        });
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
    if (!match) throw new OfflocalError(`Unknown policy token in config: ${token}.`);
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
    if (!match) throw new OfflocalError(`Unknown policy token in config: ${token}.`);
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
