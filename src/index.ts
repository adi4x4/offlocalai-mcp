#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Store } from "./storage.js";
import { ensureDefaultWorkspace } from "./service.js";
import { registerTools } from "./tools/index.js";

/**
 * offlocalai-mcp — local stdio MCP server.
 *
 * IMPORTANT: never write to stdout outside the MCP transport — it corrupts the
 * JSON-RPC stream. All logging goes to stderr.
 */
async function main(): Promise<void> {
  const store = new Store();
  ensureDefaultWorkspace(store);

  const server = new McpServer({
    name: "offlocalai-mcp",
    version: "0.0.1",
  });

  registerTools(server, store);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[offlocalai-mcp] ready — state at ${store.paths.home}`);
}

main().catch((err) => {
  console.error("[offlocalai-mcp] fatal:", err);
  process.exit(1);
});
