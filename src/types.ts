/**
 * Core domain types for offlocal.ai V0.
 *
 * These types are intentionally explicit about project + environment + provider
 * scoping. The whole point of offlocal.ai is that an AI agent must always know
 * *which* project and environment and provider account it is operating against
 * before it touches a real provider API.
 *
 * Provider credentials are read from environment variables at call time and are
 * never persisted to disk (see ProviderConnection.auth).
 */

export type ProviderId = "github" | "vercel" | "supabase" | "stripe" | "railway";

export const PROVIDER_IDS: ProviderId[] = ["github", "vercel", "supabase", "stripe", "railway"];

/** How "production-like" an environment is. Drives default policy. */
export type EnvironmentKind = "development" | "staging" | "production";

// ---------------------------------------------------------------------------
// Workspace / Project / Environment
// ---------------------------------------------------------------------------

export interface Workspace {
  id: string;
  name: string;
  createdAt: string;
}

export interface Project {
  id: string;
  workspaceId: string;
  /** Human display name, e.g. "Your Project". */
  name: string;
  /** URL/identifier-safe slug, e.g. "your-project". Unique within a workspace. */
  slug: string;
  description?: string;
  createdAt: string;
}

export interface Environment {
  id: string;
  projectId: string;
  /** e.g. "staging", "production", "dev". Unique within a project. */
  name: string;
  kind: EnvironmentKind;
  /** Convenience flag derived from kind === "production". */
  isProduction: boolean;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Provider auth + connections
// ---------------------------------------------------------------------------

/**
 * Auth reference for a provider connection. The token is read from a named
 * environment variable at runtime and is NEVER persisted to disk.
 */
export interface ProviderAuth {
  kind: "env";
  /** Name of the env var holding the secret, e.g. "GITHUB_TOKEN". */
  envVar: string;
}

/**
 * A configured way to talk to a provider. Connections are workspace-scoped so
 * multiple projects can share one account, but mappings (below) bind a specific
 * environment to a specific resource.
 */
export interface ProviderConnection {
  id: string;
  workspaceId: string;
  provider: ProviderId;
  /** Friendly label, e.g. "github-org". */
  label: string;
  auth: ProviderAuth;
  /** Optional provider-level scoping, e.g. Vercel team id. */
  scope?: {
    vercelTeamId?: string;
    githubOwner?: string;
  };
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Provider mappings (environment -> concrete provider resource)
// ---------------------------------------------------------------------------

export interface GithubResource {
  owner: string;
  repo: string;
}

export interface VercelResource {
  /** Vercel project id or name. */
  projectId: string;
  projectName?: string;
  /** Overrides connection-level team id if set. */
  teamId?: string;
}

export interface SupabaseResource {
  /** Supabase project ref, e.g. "abcdefghijklmnop". */
  projectRef: string;
}

export interface StripeResource {
  /** Which key/mode this environment uses. */
  mode: "test" | "live";
}

export interface RailwayResource {
  /** Railway project id (opaque UUID). */
  projectId: string;
  /** Railway environment id within the project (e.g. its "production" env). */
  environmentId?: string;
  /** Railway service id to scope deployments/logs to a single service. */
  serviceId?: string;
  /** Friendly Railway project name, for display only. */
  projectName?: string;
}

export type ProviderResource =
  | ({ provider: "github" } & GithubResource)
  | ({ provider: "vercel" } & VercelResource)
  | ({ provider: "supabase" } & SupabaseResource)
  | ({ provider: "stripe" } & StripeResource)
  | ({ provider: "railway" } & RailwayResource);

export interface ProviderMapping {
  id: string;
  projectId: string;
  environmentId: string;
  provider: ProviderId;
  /** Optional link to the connection that supplies credentials. */
  connectionId?: string;
  resource: ProviderResource;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * The capability a tool exercises. The policy engine reasons about capability +
 * environment kind + provider, NOT about individual tool names, so new tools
 * inherit safe defaults automatically.
 */
export type Capability =
  | "read" // safe, read-only
  | "write" // create/update non-destructively
  | "deploy" // trigger a deployment
  | "env_change" // change environment variables / config
  | "delete" // delete a resource
  | "destructive_sql"; // DROP/TRUNCATE/DELETE/ALTER etc.

export type PolicyEffect = "allow" | "block" | "approval_required";

/**
 * An explicit, user-authored rule that overrides the built-in defaults.
 * Higher `priority` wins. A rule matches when every set scope field matches the
 * action context (unset fields are wildcards).
 */
export interface PolicyRule {
  id: string;
  description?: string;
  priority: number;
  effect: PolicyEffect;
  match: {
    projectId?: string;
    environmentId?: string;
    environmentKind?: EnvironmentKind;
    provider?: ProviderId;
    capability?: Capability;
  };
  createdAt: string;
}

/** The fully-resolved context for a single attempted provider action. */
export interface ActionContext {
  project: Project;
  environment: Environment;
  provider: ProviderId;
  capability: Capability;
  /** Tool name, for audit + readable messages. */
  tool: string;
  /** Short human summary of what the action does. */
  summary: string;
  /**
   * Provider-specific risk signal: true when the action targets a "live" /
   * irreversible context independent of environment kind (e.g. a Stripe live
   * key, or an environment explicitly flagged production-like). Lets policy
   * require approval even if the environment kind looks benign.
   */
  live?: boolean;
  /** Concrete provider resource touched, for the audit log. */
  resourceLabel?: string;
}

export interface PolicyDecision {
  effect: PolicyEffect;
  reason: string;
  /** Which rule (or the default engine) produced this decision. */
  source: string;
}

// ---------------------------------------------------------------------------
// Audit + memory
// ---------------------------------------------------------------------------

export type AuditResult = "success" | "error" | "not_executed";

export interface AuditLogEntry {
  timestamp: string;
  projectSlug?: string;
  environment?: string;
  provider?: ProviderId | "core";
  tool: string;
  actionSummary: string;
  policyDecision: PolicyEffect | "n/a";
  result: AuditResult;
  errorMessage?: string;
  /** The concrete provider resource touched, e.g. "your-org/your-repo" or "test". */
  providerResource?: string;
  /** Agent / MCP client info if the transport exposed it. */
  agent?: string;
}

export interface ProjectMemory {
  id: string;
  projectId: string;
  /** Optional environment scoping; omit for project-wide notes. */
  environmentId?: string;
  note: string;
  tags?: string[];
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Persisted state
// ---------------------------------------------------------------------------

export interface OfflocalState {
  version: 1;
  workspaces: Workspace[];
  projects: Project[];
  environments: Environment[];
  connections: ProviderConnection[];
  mappings: ProviderMapping[];
  policyRules: PolicyRule[];
  /** Currently selected project id (for tools that omit an explicit project). */
  selectedProjectId?: string;
  /** Default workspace id. */
  defaultWorkspaceId?: string;
}
