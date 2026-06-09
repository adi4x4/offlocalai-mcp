#!/usr/bin/env node
import { Store } from "./storage.js";
import {
  addEnvironment,
  createProject,
  ensureDefaultWorkspace,
  getProjectContext,
  listEnvironments,
  listProjects,
  mapProviderResource,
  selectProject,
} from "./service.js";
import { seedFromConfigFile } from "./config.js";
import type { ProviderId, ProviderResource } from "./types.js";
import { resolve } from "node:path";

/**
 * Minimal `offlocal` CLI. The MCP tools are the primary interface; this CLI is a
 * convenience for setup and inspection. All commands operate on the same
 * `.offlocal/` state as the server.
 */

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function print(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

const REQUIRED_ENV_VARS = [
  ["GITHUB_TOKEN", "GitHub fine-grained PAT (Metadata: read, Contents: read)"],
  ["VERCEL_TOKEN", "Vercel account/team token"],
  ["VERCEL_TEAM_ID", "optional — required for team-owned Vercel resources"],
  ["SUPABASE_ACCESS_TOKEN", "Supabase personal access token"],
  ["STRIPE_TEST_SECRET_KEY", "Stripe sk_test_… key"],
  ["STRIPE_LIVE_SECRET_KEY", "Stripe sk_live_… key (only used when policy allows a live write)"],
  ["RAILWAY_TOKEN", "Railway account/workspace token"],
];

/** Print the MCP client config snippet + required env vars after init. */
function printSetupHelp(serverEntry: string): void {
  const lines: string[] = [];
  lines.push("");
  lines.push("Next steps");
  lines.push("==========");
  lines.push("");
  lines.push("1) Set the provider env vars you'll use (only the ones you need):");
  for (const [name, desc] of REQUIRED_ENV_VARS) lines.push(`   - ${name}  — ${desc}`);
  lines.push("");
  lines.push("2) Add this MCP server to your coding agent:");
  lines.push("");
  lines.push("   Claude Code  → .mcp.json in your repo root:");
  lines.push(
    JSON.stringify(
      {
        mcpServers: {
          offlocalai: {
            type: "stdio",
            command: "node",
            args: [serverEntry],
            env: {
              GITHUB_TOKEN: "${GITHUB_TOKEN}",
              VERCEL_TOKEN: "${VERCEL_TOKEN}",
              SUPABASE_ACCESS_TOKEN: "${SUPABASE_ACCESS_TOKEN}",
              STRIPE_TEST_SECRET_KEY: "${STRIPE_TEST_SECRET_KEY}",
              STRIPE_LIVE_SECRET_KEY: "${STRIPE_LIVE_SECRET_KEY}",
              RAILWAY_TOKEN: "${RAILWAY_TOKEN}",
            },
          },
        },
      },
      null,
      2,
    )
      .split("\n")
      .map((l) => "   " + l)
      .join("\n"),
  );
  lines.push("");
  lines.push("   Cursor → .cursor/mcp.json (same shape, drop the \"type\" field).");
  lines.push("   Codex  → ~/.codex/config.toml:");
  lines.push("     [mcp_servers.offlocalai]");
  lines.push(`     command = "node"`);
  lines.push(`     args = ["${serverEntry.replace(/\\/g, "\\\\")}"]`);
  lines.push("");
  lines.push("3) Then ask your agent (using your project/environment names):");
  lines.push('   "Use offlocalai to get the context for <project> <environment> and tell me what is safe to touch."');
  lines.push("");
  console.log(lines.join("\n"));
}

const HELP = `offlocal — production context layer for AI coding agents

Usage:
  offlocal init [--config <path>]          Seed state from .offlocal/config.yaml if present
  offlocal project create <name> [--slug <s>] [--desc <d>]
  offlocal project list
  offlocal select <project>                Set the active project
  offlocal env add <name> [--project <p>] [--kind development|staging|production]
  offlocal env list [--project <p>]
  offlocal map <provider> <environment> --resource '<json>' [--project <p>]
  offlocal context [project] [--env <e>] [--json]   Print the production-context summary

Providers: github | vercel | supabase | stripe | railway
Resource JSON examples:
  github:   {"owner":"your-org","repo":"your-repo"}
  vercel:   {"projectId":"your-vercel-project"}
  supabase: {"projectRef":"your_project_ref"}
  stripe:   {"mode":"live"}
  railway:  {"projectId":"your-railway-project-id","environmentId":"...","serviceId":"..."}
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help") {
    console.log(HELP);
    return;
  }

  const store = new Store();
  ensureDefaultWorkspace(store);
  const cmd = argv[0];
  // Parse flags from ALL args after the command, so flags work whether or not a
  // subcommand is present (e.g. `init --config x`). Subcommands are positional[0].
  const { positional, flags } = parseFlags(argv.slice(1));
  const sub = positional[0];

  switch (cmd) {
    case "init": {
      const serverEntry = resolve(process.cwd(), "dist", "index.js");
      const path = flags.config ?? store.paths.config;
      const result = seedFromConfigFile(store, path);
      if (!result) {
        print({
          status: "ok",
          home: store.paths.home,
          message: `Initialized empty state at ${store.paths.home}. No config.yaml at ${path}. Copy .offlocal/config.example.yaml to .offlocal/config.yaml and edit it, then re-run \`offlocal init\` (or create projects with \`offlocal project create\` / \`offlocal map\`).`,
        });
      } else {
        print({ status: "ok", seededFrom: path, home: store.paths.home, ...result });
      }
      printSetupHelp(serverEntry);
      return;
    }

    case "project": {
      if (sub === "create") {
        const name = positional[1];
        if (!name) return print({ status: "error", error: "Usage: offlocal project create <name>" });
        print({ status: "ok", project: createProject(store, { name, slug: flags.slug, description: flags.desc }) });
      } else if (sub === "list") {
        print({ status: "ok", projects: listProjects(store) });
      } else {
        print({ status: "error", error: "Unknown project subcommand. Try: create | list" });
      }
      return;
    }

    case "select": {
      if (!sub) return print({ status: "error", error: "Usage: offlocal select <project>" });
      print({ status: "ok", project: selectProject(store, sub) });
      return;
    }

    case "env": {
      if (sub === "add") {
        const name = positional[1];
        if (!name) return print({ status: "error", error: "Usage: offlocal env add <name>" });
        print({
          status: "ok",
          environment: addEnvironment(store, {
            project: flags.project,
            name,
            kind: flags.kind as any,
          }),
        });
      } else if (sub === "list") {
        print({ status: "ok", environments: listEnvironments(store, flags.project) });
      } else {
        print({ status: "error", error: "Unknown env subcommand. Try: add | list" });
      }
      return;
    }

    case "map": {
      const provider = sub as ProviderId;
      const environment = positional[1];
      if (!provider || !environment || !flags.resource) {
        return print({ status: "error", error: "Usage: offlocal map <provider> <environment> --resource '<json>'" });
      }
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(flags.resource);
      } catch {
        return print({ status: "error", error: "--resource must be valid JSON" });
      }
      const resource = { provider, ...parsed } as ProviderResource;
      const res = mapProviderResource(store, { project: flags.project, environment, provider, resource });
      print({ status: "ok", project: res.project.slug, environment: res.environment.name, mappingId: res.mappingId });
      return;
    }

    case "context": {
      const context = await getProjectContext(store, sub, flags.env);
      if (flags.json === "true") {
        print({ status: "ok", context });
      } else {
        // Default: print the human-readable summary (the killer view).
        console.log(context.summary);
      }
      return;
    }

    default:
      console.log(HELP);
  }
}

main().catch((err) => {
  print({ status: "error", error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
