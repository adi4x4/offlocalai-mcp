import { afterEach, describe, expect, it, vi } from "vitest";
import { dashclawConfigFromEnv, dashclawFetch } from "../src/dashclaw/client.js";
import { normalizeDashclawDecision } from "../src/dashclaw/guard.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DASHCLAW_BASE_URL;
  delete process.env.DASHCLAW_API_KEY;
  delete process.env.DASHCLAW_TIMEOUT_MS;
});

describe("DashClaw client", () => {
  it("reads env config without storing secrets", () => {
    process.env.DASHCLAW_BASE_URL = "https://dashclaw.example";
    process.env.DASHCLAW_API_KEY = "dc_secret";

    const config = dashclawConfigFromEnv();

    expect(config).toMatchObject({
      baseUrl: "https://dashclaw.example",
      apiKey: "dc_secret",
      timeoutMs: 30000,
      mode: "authoritative",
    });
  });

  it("fails clearly when required env vars are missing", () => {
    expect(() => dashclawConfigFromEnv()).toThrow(/DASHCLAW_BASE_URL/i);
  });

  it("sends x-api-key and redacts secrets in HTTP errors", async () => {
    process.env.DASHCLAW_BASE_URL = "https://dashclaw.example";
    process.env.DASHCLAW_API_KEY = "dc_secret";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "bad key dc_secret" }), {
          status: 403,
          statusText: "Forbidden",
        }),
      ),
    );

    await expect(dashclawFetch("/api/guard", { method: "POST", body: { action_type: "provider_deploy" } })).rejects.toThrow(
      /REDACTED/,
    );

    expect(fetch).toHaveBeenCalledWith(
      "https://dashclaw.example/api/guard",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-api-key": "dc_secret" }),
      }),
    );
  });
});

describe("DashClaw decision normalization", () => {
  it.each([
    ["allow", "allow"],
    ["block", "block"],
    ["require_approval", "require_approval"],
    ["approval_required", "require_approval"],
  ] as const)("normalizes %s", (input, expected) => {
    expect(normalizeDashclawDecision(input)).toBe(expected);
  });

  it("rejects unknown decisions loudly", () => {
    expect(() => normalizeDashclawDecision("unsupported_decision")).toThrow(/unknown DashClaw decision/i);
  });
});
