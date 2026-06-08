import type { Store } from "./storage.js";
import { buildProjectContext, type ProjectContext } from "./context.js";
import { evaluatePolicy } from "./policy.js";
import { resolveEnvironment, resolveProject, requireMapping } from "./resolve.js";
import { defaultEnvVar } from "./providers/auth.js";
import type {
  ActionContext,
  Capability,
  Environment,
  EnvironmentKind,
  PolicyEffect,
  PolicyRule,
  Project,
  ProviderId,
  ProviderResource,
  Workspace,
} from "./types.js";
import { newId, nowIso, OfflocalError, slugify } from "./util.js";

/**
 * Service layer: all business logic lives here as plain functions over a Store.
 * The MCP server (src/tools) and the CLI (src/cli.ts) are thin wrappers around
 * these — so everything is unit-testable without a transport.
 */

// ---------------------------------------------------------------------------
// Workspace / project / environment
// ---------------------------------------------------------------------------

export function ensureDefaultWorkspace(store: Store): Workspace {
  const existing = store.data.workspaces.find((w) => w.id === store.data.defaultWorkspaceId)
    ?? store.data.workspaces[0];
  if (existing) {
    if (!store.data.defaultWorkspaceId) {
      store.update((s) => {
        s.defaultWorkspaceId = existing.id;
      });
    }
    return existing;
  }
  const ws: Workspace = { id: newId("ws"), name: "default", createdAt: nowIso() };
  store.update((s) => {
    s.workspaces.push(ws);
    s.defaultWorkspaceId = ws.id;
  });
  return ws;
}

export function createProject(
  store: Store,
  input: { name: string; slug?: string; description?: string },
): Project {
  const ws = ensureDefaultWorkspace(store);
  const slug = slugify(input.slug ?? input.name);
  if (!slug) throw new OfflocalError("Project name/slug produced an empty slug.");
  if (store.data.projects.some((p) => p.workspaceId === ws.id && p.slug === slug)) {
    throw new OfflocalError(`A project with slug "${slug}" already exists.`);
  }
  const project: Project = {
    id: newId("proj"),
    workspaceId: ws.id,
    name: input.name,
    slug,
    description: input.description,
    createdAt: nowIso(),
  };
  store.update((s) => {
    s.projects.push(project);
    if (!s.selectedProjectId) s.selectedProjectId = project.id;
  });
  return project;
}

export function listProjects(store: Store): Array<Project & { selected: boolean }> {
  return store.data.projects.map((p) => ({
    ...p,
    selected: p.id === store.data.selectedProjectId,
  }));
}

export function selectProject(store: Store, projectRef: string): Project {
  const project = resolveProject(store, projectRef);
  store.update((s) => {
    s.selectedProjectId = project.id;
  });
  return project;
}

const KIND_BY_NAME: Record<string, EnvironmentKind> = {
  dev: "development",
  development: "development",
  local: "development",
  staging: "staging",
  stage: "staging",
  preview: "staging",
  prod: "production",
  production: "production",
};

export function addEnvironment(
  store: Store,
  input: { project?: string; name: string; kind?: EnvironmentKind },
): Environment {
  const project = resolveProject(store, input.project);
  const kind: EnvironmentKind = input.kind ?? KIND_BY_NAME[input.name.toLowerCase()] ?? "development";
  if (
    store.data.environments.some(
      (e) => e.projectId === project.id && e.name === input.name,
    )
  ) {
    throw new OfflocalError(
      `Environment "${input.name}" already exists for project "${project.slug}".`,
    );
  }
  const env: Environment = {
    id: newId("env"),
    projectId: project.id,
    name: input.name,
    kind,
    isProduction: kind === "production",
    createdAt: nowIso(),
  };
  store.update((s) => {
    s.environments.push(env);
  });
  return env;
}

export function listEnvironments(store: Store, projectRef?: string): Environment[] {
  const project = resolveProject(store, projectRef);
  return store.data.environments.filter((e) => e.projectId === project.id);
}

export function getProjectContext(
  store: Store,
  projectRef?: string,
  environment?: string,
): Promise<ProjectContext> {
  const project = resolveProject(store, projectRef);
  return buildProjectContext(store, project, environment);
}

// ---------------------------------------------------------------------------
// Provider connections + mappings
// ---------------------------------------------------------------------------

export function ensureConnection(
  store: Store,
  provider: ProviderId,
  opts?: { label?: string; envVar?: string; vercelTeamId?: string },
): string {
  const existing = store.data.connections.find((c) => c.provider === provider);
  if (existing) return existing.id;
  const ws = ensureDefaultWorkspace(store);
  const id = newId("conn");
  store.update((s) => {
    s.connections.push({
      id,
      workspaceId: ws.id,
      provider,
      label: opts?.label ?? `${provider}-default`,
      auth: { kind: "env", envVar: opts?.envVar ?? defaultEnvVar(provider) },
      scope: opts?.vercelTeamId ? { vercelTeamId: opts.vercelTeamId } : undefined,
      createdAt: nowIso(),
    });
  });
  return id;
}

export function mapProviderResource(
  store: Store,
  input: {
    project?: string;
    environment: string;
    provider: ProviderId;
    resource: ProviderResource;
    connectionId?: string;
  },
): { project: Project; environment: Environment; mappingId: string } {
  const project = resolveProject(store, input.project);
  const environment = resolveEnvironment(store, project, input.environment);
  if (input.resource.provider !== input.provider) {
    throw new OfflocalError(
      `Resource provider "${input.resource.provider}" does not match "${input.provider}".`,
    );
  }
  const connectionId = input.connectionId ?? ensureConnection(store, input.provider);
  const id = newId("map");
  store.update((s) => {
    // Replace any existing mapping for this env+provider (one resource per pair).
    s.mappings = s.mappings.filter(
      (m) => !(m.environmentId === environment.id && m.provider === input.provider),
    );
    s.mappings.push({
      id,
      projectId: project.id,
      environmentId: environment.id,
      provider: input.provider,
      connectionId,
      resource: input.resource,
      createdAt: nowIso(),
    });
  });
  return { project, environment, mappingId: id };
}

export function listProviderMappings(store: Store, projectRef?: string) {
  const project = resolveProject(store, projectRef);
  const envName = (id: string) =>
    store.data.environments.find((e) => e.id === id)?.name ?? id;
  return store.data.mappings
    .filter((m) => m.projectId === project.id)
    .map((m) => ({
      id: m.id,
      environment: envName(m.environmentId),
      provider: m.provider,
      resource: m.resource,
    }));
}

export function getProviderMapping(
  store: Store,
  input: { project?: string; environment: string; provider: ProviderId },
) {
  const project = resolveProject(store, input.project);
  const environment = resolveEnvironment(store, project, input.environment);
  const mapping = requireMapping(store, project, environment, input.provider);
  return {
    id: mapping.id,
    project: project.slug,
    environment: environment.name,
    provider: mapping.provider,
    resource: mapping.resource,
  };
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export function checkPolicy(
  store: Store,
  input: {
    project?: string;
    environment: string;
    provider: ProviderId;
    capability: Capability;
    live?: boolean;
  },
) {
  const project = resolveProject(store, input.project);
  const environment = resolveEnvironment(store, project, input.environment);
  const ctx: ActionContext = {
    project,
    environment,
    provider: input.provider,
    capability: input.capability,
    tool: "check_policy",
    summary: `policy check for ${input.provider}.${input.capability}`,
    live: input.live,
  };
  const decision = evaluatePolicy(store.data.policyRules, ctx);
  return {
    project: project.slug,
    environment: environment.name,
    provider: input.provider,
    capability: input.capability,
    effect: decision.effect,
    reason: decision.reason,
    source: decision.source,
  };
}

export function listPolicyRules(store: Store): PolicyRule[] {
  return [...store.data.policyRules].sort((a, b) => b.priority - a.priority);
}

export function setPolicyRule(
  store: Store,
  input: {
    effect: PolicyEffect;
    description?: string;
    priority?: number;
    match: PolicyRule["match"];
  },
): PolicyRule {
  const rule: PolicyRule = {
    id: newId("rule"),
    description: input.description,
    priority: input.priority ?? 100,
    effect: input.effect,
    match: input.match,
    createdAt: nowIso(),
  };
  store.update((s) => {
    s.policyRules.push(rule);
  });
  return rule;
}

// ---------------------------------------------------------------------------
// Memory + audit
// ---------------------------------------------------------------------------

export function writeProjectMemory(
  store: Store,
  input: { project?: string; environment?: string; note: string; tags?: string[] },
) {
  const project = resolveProject(store, input.project);
  const environmentId = input.environment
    ? resolveEnvironment(store, project, input.environment).id
    : undefined;
  const entry = {
    id: newId("mem"),
    projectId: project.id,
    environmentId,
    note: input.note,
    tags: input.tags,
    createdAt: nowIso(),
  };
  store.addMemory(entry);
  return entry;
}

export function readProjectMemory(
  store: Store,
  input: { project?: string; environment?: string },
) {
  const project = resolveProject(store, input.project);
  const environmentId = input.environment
    ? resolveEnvironment(store, project, input.environment).id
    : undefined;
  return store.listMemory({ projectId: project.id, environmentId });
}

export function listAuditLog(
  store: Store,
  input: { project?: string; environment?: string; provider?: ProviderId; limit?: number } = {},
) {
  let projectSlug: string | undefined;
  if (input.project) projectSlug = resolveProject(store, input.project).slug;
  return store.readAudit(input.limit ?? 50, {
    projectSlug,
    environment: input.environment,
    provider: input.provider,
  });
}

