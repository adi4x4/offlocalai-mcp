import type { Store } from "./storage.js";
import type {
  Environment,
  Project,
  ProviderConnection,
  ProviderId,
  ProviderMapping,
} from "./types.js";
import { OfflocalError } from "./util.js";

/** Find a project by id or slug. Falls back to the selected project. */
export function resolveProject(store: Store, projectRef?: string): Project {
  const { projects, selectedProjectId } = store.data;
  if (projectRef) {
    const found = projects.find((p) => p.id === projectRef || p.slug === projectRef);
    if (!found) {
      throw new OfflocalError(
        `No project matches "${projectRef}". Use list_projects to see available projects.`,
      );
    }
    return found;
  }
  if (selectedProjectId) {
    const sel = projects.find((p) => p.id === selectedProjectId);
    if (sel) return sel;
  }
  if (projects.length === 1) return projects[0]!;
  throw new OfflocalError(
    "No project specified and none selected. Pass `project` or call select_project first.",
  );
}

export function resolveEnvironment(
  store: Store,
  project: Project,
  envRef?: string,
): Environment {
  const envs = store.data.environments.filter((e) => e.projectId === project.id);
  if (envRef) {
    const found = envs.find((e) => e.id === envRef || e.name === envRef);
    if (!found) {
      throw new OfflocalError(
        `Project "${project.slug}" has no environment "${envRef}". ` +
          `Known: ${envs.map((e) => e.name).join(", ") || "(none)"}.`,
      );
    }
    return found;
  }
  if (envs.length === 1) return envs[0]!;
  throw new OfflocalError(
    `Project "${project.slug}" has multiple environments — specify which: ${envs
      .map((e) => e.name)
      .join(", ")}.`,
  );
}

export function findMapping(
  store: Store,
  environment: Environment,
  provider: ProviderId,
): ProviderMapping | undefined {
  return store.data.mappings.find(
    (m) => m.environmentId === environment.id && m.provider === provider,
  );
}

export function requireMapping(
  store: Store,
  project: Project,
  environment: Environment,
  provider: ProviderId,
): ProviderMapping {
  const m = findMapping(store, environment, provider);
  if (!m) {
    throw new OfflocalError(
      `No ${provider} mapping for ${project.slug}/${environment.name}. ` +
        `Add one with map_provider_resource.`,
    );
  }
  return m;
}

export function findConnection(
  store: Store,
  provider: ProviderId,
  connectionId?: string,
): ProviderConnection | undefined {
  if (connectionId) {
    return store.data.connections.find((c) => c.id === connectionId);
  }
  return store.data.connections.find((c) => c.provider === provider);
}

/**
 * Resolve a connection by id or by label (scoped to the provider). Used when a
 * mapping is bound to a specific named account, e.g. "vercel-client-a".
 */
export function resolveConnection(
  store: Store,
  provider: ProviderId,
  ref: string,
): ProviderConnection {
  const forProvider = store.data.connections.filter((c) => c.provider === provider);
  const found =
    store.data.connections.find((c) => c.id === ref) ??
    forProvider.find((c) => c.label === ref);
  if (!found) {
    throw new OfflocalError(
      `No ${provider} connection matches "${ref}". ` +
        `Known ${provider} connections: ${forProvider.map((c) => c.label).join(", ") || "(none)"}. ` +
        `Add one with add_provider_connection.`,
    );
  }
  if (found.provider !== provider) {
    throw new OfflocalError(
      `Connection "${ref}" is a ${found.provider} connection, not ${provider}.`,
    );
  }
  return found;
}
