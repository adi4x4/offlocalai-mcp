import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import type {
  AuditLogEntry,
  OfflocalState,
  ProjectMemory,
} from "./types.js";
import { offlocalPaths, type OfflocalPaths } from "./paths.js";

function emptyState(): OfflocalState {
  return {
    version: 1,
    workspaces: [],
    projects: [],
    environments: [],
    connections: [],
    mappings: [],
    policyRules: [],
  };
}

/**
 * Local-first JSON storage for V0.
 *
 * We deliberately use plain JSON files rather than SQLite so the project has
 * zero native dependencies (clean install on every OS, including Windows) and
 * the state is human-readable/diffable. The Store keeps an in-memory copy and
 * write-through-persists on every mutation. Concurrency within a single MCP
 * process is fine; cross-process locking is a documented non-goal for V0.
 */
export class Store {
  readonly paths: OfflocalPaths;
  private state: OfflocalState;
  private memory: ProjectMemory[];

  constructor(paths: OfflocalPaths = offlocalPaths()) {
    this.paths = paths;
    this.ensureHome();
    this.state = this.loadState();
    this.memory = this.loadMemory();
  }

  private ensureHome(): void {
    if (!existsSync(this.paths.home)) {
      mkdirSync(this.paths.home, { recursive: true });
    }
  }

  private loadState(): OfflocalState {
    if (!existsSync(this.paths.state)) return emptyState();
    try {
      const raw = readFileSync(this.paths.state, "utf8");
      const parsed = JSON.parse(raw) as OfflocalState;
      // Tolerate older/partial files by merging onto an empty shell.
      return { ...emptyState(), ...parsed };
    } catch {
      return emptyState();
    }
  }

  private loadMemory(): ProjectMemory[] {
    if (!existsSync(this.paths.memory)) return [];
    try {
      return JSON.parse(readFileSync(this.paths.memory, "utf8")) as ProjectMemory[];
    } catch {
      return [];
    }
  }

  // --- state access --------------------------------------------------------

  /** Direct read access. Callers must NOT mutate the returned object in place. */
  get data(): Readonly<OfflocalState> {
    return this.state;
  }

  /** Apply a mutation to state and persist. */
  update(mutator: (state: OfflocalState) => void): void {
    mutator(this.state);
    this.persistState();
  }

  private persistState(): void {
    this.ensureHome();
    writeFileSync(this.paths.state, JSON.stringify(this.state, null, 2));
  }

  // --- memory --------------------------------------------------------------

  listMemory(filter?: { projectId?: string; environmentId?: string }): ProjectMemory[] {
    return this.memory.filter((m) => {
      if (filter?.projectId && m.projectId !== filter.projectId) return false;
      if (filter?.environmentId && m.environmentId !== filter.environmentId) return false;
      return true;
    });
  }

  addMemory(entry: ProjectMemory): void {
    this.memory.push(entry);
    this.persistMemory();
  }

  private persistMemory(): void {
    this.ensureHome();
    writeFileSync(this.paths.memory, JSON.stringify(this.memory, null, 2));
  }

  // --- audit ---------------------------------------------------------------

  /** Append one audit entry as a JSON line. Audit writes are append-only. */
  appendAudit(entry: AuditLogEntry): void {
    this.ensureHome();
    appendFileSync(this.paths.audit, JSON.stringify(entry) + "\n");
  }

  readAudit(
    limit = 50,
    filter?: { projectSlug?: string; environment?: string; provider?: string },
  ): AuditLogEntry[] {
    if (!existsSync(this.paths.audit)) return [];
    const lines = readFileSync(this.paths.audit, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
    const entries: AuditLogEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as AuditLogEntry);
      } catch {
        // skip corrupt lines
      }
    }
    const filtered = entries.filter((e) => {
      if (filter?.projectSlug && e.projectSlug !== filter.projectSlug) return false;
      if (filter?.environment && e.environment !== filter.environment) return false;
      if (filter?.provider && e.provider !== filter.provider) return false;
      return true;
    });
    // Most recent last in the file; return the newest `limit`, newest first.
    return filtered.slice(-limit).reverse();
  }
}
