import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

interface PackedFile {
  path: string;
}

interface PackResult {
  files: PackedFile[];
}

function packedPaths(): string[] {
  const out = execSync("npm pack --dry-run --json", {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  const result = JSON.parse(out) as PackResult[];
  return result[0]!.files.map((f) => f.path);
}

describe("npm package contents", () => {
  it("builds before running tests in the shared verify gate", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(pkg.scripts.verify).toBe("npm run typecheck && npm run build && npm test && npm audit");
  });

  it("includes README-linked docs and example config", () => {
    expect(packedPaths()).toEqual(
      expect.arrayContaining([
        "docs/provider-research.md",
        ".offlocal/config.example.yaml",
        ".env.example",
      ]),
    );
  });

  it("keeps README smoke-test commands and runtime env docs present", () => {
    const readme = readFileSync("README.md", "utf8");

    expect(readme).toContain("npx -p @offlocal/mcp offlocal init");
    expect(readme).toContain("offlocal-mcp");
    expect(readme).toContain("OFFLOCAL_HTTP_RETRIES");
    expect(readme).toContain("OFFLOCAL_AUDIT_MAX_ENTRIES");
    expect(readme).toContain("Governed Infrastructure Actions");
    expect(readme).toContain("DASHCLAW_BASE_URL");
    expect(readme).toContain("DASHCLAW_API_KEY");
    expect(readme).toContain("dashclaw_status");
  });
});
