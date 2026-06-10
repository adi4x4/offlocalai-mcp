import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { freshStore, seedAcme } from "./helpers.js";
import * as pa from "../src/provider-actions.js";
import { defaultEnvVar } from "../src/providers/auth.js";
import { listAuditLog, listPendingApprovals, mapProviderResource, setPolicyRule } from "../src/service.js";
import type { Store } from "../src/storage.js";

/**
 * These tests exercise the guarded provider flow with a mocked global fetch, so
 * no real network calls happen. The key assertions are:
 *   - allowed actions EXECUTE (fetch is called) and audit "success";
 *   - approval_required / blocked actions DO NOT execute (fetch not called) and
 *     audit "not_executed".
 */

let fetchMock: ReturnType<typeof vi.fn>;
let dashclawDecision: Record<string, unknown>;

function mockOk(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function dashclawRoute(url: string): Response | undefined {
  if (url === "https://dashclaw.example/api/guard") {
    return mockOk(dashclawDecision);
  }
  if (url.startsWith("https://dashclaw.example/api/actions/") && url.endsWith("/outcome")) {
    return mockOk({ ok: true });
  }
  return undefined;
}

function withDashclawRoute(providerRoute: (url: string, init?: any) => Response | Promise<Response>) {
  return async (url: string, init?: any) => dashclawRoute(url) ?? providerRoute(url, init);
}

function setDashclawDecision(decision: "allow" | "block" | "require_approval", suffix = decision) {
  dashclawDecision = {
    decision,
    reason: `DashClaw ${decision}`,
    decision_id: `gd_${suffix}`,
    action_id: `act_${suffix}`,
  };
}

beforeEach(() => {
  process.env.DASHCLAW_BASE_URL = "https://dashclaw.example";
  process.env.DASHCLAW_API_KEY = "dc_test";
  setDashclawDecision("allow");
  fetchMock = vi.fn(withDashclawRoute(() => mockOk({ id: "obj_123", name: "Test", active: true, created: 1 })));
  vi.stubGlobal("fetch", fetchMock);
  process.env.STRIPE_TEST_SECRET_KEY = "sk_test_dummy";
  process.env.STRIPE_LIVE_SECRET_KEY = "sk_live_dummy";
  process.env.GITHUB_TOKEN = "gh_dummy";
  process.env.VERCEL_TOKEN = "vc_dummy";
  process.env.SUPABASE_ACCESS_TOKEN = "sb_dummy";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CUSTOM_GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.CUSTOM_VERCEL_TOKEN;
  delete process.env.CUSTOM_STRIPE_TEST_KEY;
  delete process.env.DASHCLAW_BASE_URL;
  delete process.env.DASHCLAW_API_KEY;
});

function lastAudit(store: Store) {
  return listAuditLog(store, { project: "acme-crm" })[0];
}

function providerCalls() {
  return fetchMock.mock.calls.filter(([url]) => typeof url === "string" && !url.startsWith("https://dashclaw.example"));
}

describe("provider auth defaults", () => {
  it("returns NAMECHEAP_API_KEY and NEON_API_KEY for the new providers", () => {
    expect(defaultEnvVar("namecheap")).toBe("NAMECHEAP_API_KEY");
    expect(defaultEnvVar("neon")).toBe("NEON_API_KEY");
  });
});

describe("Stripe", () => {
  it("uses the mapping connection token for Stripe calls", async () => {
    const store = freshStore();
    seedAcme(store);
    process.env.CUSTOM_STRIPE_TEST_KEY = "sk_test_custom";
    store.update((s) => {
      s.connections.push({
        id: "conn_custom_stripe",
        workspaceId: s.defaultWorkspaceId!,
        provider: "stripe",
        label: "custom-stripe",
        auth: { kind: "env", envVar: "CUSTOM_STRIPE_TEST_KEY" },
        createdAt: new Date().toISOString(),
      });
    });
    mapProviderResource(store, {
      environment: "staging",
      provider: "stripe",
      connectionId: "conn_custom_stripe",
      resource: { provider: "stripe", mode: "test" },
    });
    fetchMock.mockResolvedValueOnce(mockOk({ data: [{ id: "prod_123", name: "Pro", active: true, created: 1 }] }));

    const res = await pa.stripeListProducts(store, { environment: "staging", limit: 1 });

    expect(res.status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.stripe.com/v1/products?limit=1",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer sk_test_custom" }),
      }),
    );
  });

  it("allows test-mode writes and executes them", async () => {
    const store = freshStore();
    seedAcme(store);
    const res = await pa.stripeCreateProduct(store, {
      environment: "staging", // staging -> stripe mode test
      name: "Pro Plan",
    });
    expect(res.status).toBe("ok");
    expect(providerCalls()).toHaveLength(1);
    expect(lastAudit(store)).toMatchObject({ result: "success", policyDecision: "allow", provider: "stripe" });
  });

  it("requires approval for live-mode writes and does NOT execute them", async () => {
    setDashclawDecision("require_approval", "stripe_live");
    const store = freshStore();
    seedAcme(store);
    const res = await pa.stripeCreateProduct(store, {
      environment: "production", // production -> stripe mode live
      name: "Pro Plan",
    });
    expect(res.status).toBe("approval_required");
    expect((res as any).approval_id).toBe("act_stripe_live");
    expect(providerCalls()).toHaveLength(0);
    expect(lastAudit(store)).toMatchObject({
      result: "not_executed",
      policyDecision: "approval_required",
      dashclawDecisionId: "gd_stripe_live",
      dashclawActionId: "act_stripe_live",
    });
  });
});

describe("mapped provider connections", () => {
  it("uses the mapping connection token for provider calls", async () => {
    const store = freshStore();
    seedAcme(store);
    process.env.CUSTOM_GITHUB_TOKEN = "gh_custom";
    store.update((s) => {
      s.connections.push({
        id: "conn_custom_github",
        workspaceId: s.defaultWorkspaceId!,
        provider: "github",
        label: "custom-github",
        auth: { kind: "env", envVar: "CUSTOM_GITHUB_TOKEN" },
        createdAt: new Date().toISOString(),
      });
    });
    mapProviderResource(store, {
      environment: "staging",
      provider: "github",
      connectionId: "conn_custom_github",
      resource: { provider: "github", owner: "acme", repo: "acme-crm" },
    });
    fetchMock.mockResolvedValueOnce(mockOk({
      full_name: "acme/acme-crm",
      default_branch: "main",
      private: true,
      pushed_at: "2026-06-09T12:00:00.000Z",
      open_issues_count: 0,
      html_url: "https://github.com/acme/acme-crm",
    }));

    const res = await pa.githubRepoContext(store, { environment: "staging" });

    expect(res.status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/repos/acme/acme-crm",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer gh_custom" }),
      }),
    );
  });

  it("retries transient read failures for idempotent provider calls", async () => {
    const store = freshStore();
    seedAcme(store);
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "temporary" }), { status: 503, statusText: "Service Unavailable" }))
      .mockResolvedValueOnce(mockOk({
        full_name: "acme/acme-crm",
        default_branch: "main",
        private: true,
        pushed_at: "2026-06-09T12:00:00.000Z",
        open_issues_count: 0,
        html_url: "https://github.com/acme/acme-crm",
      }));

    const res = await pa.githubRepoContext(store, { environment: "staging" });

    expect(res.status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails clearly when provider responses have the wrong shape", async () => {
    const store = freshStore();
    seedAcme(store);
    fetchMock.mockResolvedValueOnce(mockOk({ default_branch: "main" }));

    const res = await pa.githubRepoContext(store, { environment: "staging" });

    expect(res.status).toBe("error");
    expect((res as any).error).toMatch(/github repo.*full_name/i);
    expect(lastAudit(store)).toMatchObject({ result: "error", provider: "github" });
  });

  it("lists GitHub pull requests through the guarded read path", async () => {
    const store = freshStore();
    seedAcme(store);
    fetchMock.mockResolvedValueOnce(mockOk([
      {
        number: 7,
        title: "Ship feature",
        state: "open",
        draft: false,
        head: { ref: "feature" },
        base: { ref: "main" },
        html_url: "https://github.com/acme/acme-crm/pull/7",
        updated_at: "2026-06-09T12:00:00.000Z",
      },
    ]));

    const res = await pa.githubPullRequests(store, { environment: "staging", limit: 1 });

    expect(res.status).toBe("ok");
    expect((res as any).data[0]).toMatchObject({ number: 7, headRef: "feature", baseRef: "main" });
    expect(lastAudit(store)).toMatchObject({ result: "success", provider: "github", tool: "list_github_pull_requests" });
  });
});

describe("Namecheap", () => {
  beforeEach(() => {
    process.env.NAMECHEAP_API_USER = "ncuser";
    process.env.NAMECHEAP_API_KEY = "nc_dummy_key";
    process.env.NAMECHEAP_CLIENT_IP = "203.0.113.7";
    process.env.NAMECHEAP_SANDBOX = "true";
  });

  afterEach(() => {
    delete process.env.NAMECHEAP_API_USER;
    delete process.env.NAMECHEAP_API_KEY;
    delete process.env.NAMECHEAP_CLIENT_IP;
    delete process.env.NAMECHEAP_SANDBOX;
  });

  function mockXml(body: string) {
    return new Response(body, { status: 200, headers: { "content-type": "application/xml" } });
  }

  const CHECK_XML = `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse xmlns="http://api.namecheap.com/xml.response" Status="OK">
<Errors/>
<RequestedCommand>namecheap.domains.check</RequestedCommand>
<CommandResponse Type="namecheap.domains.check">
<DomainCheckResult Domain="taken.com" Available="false" ErrorNo="0" Description="" IsPremiumName="false" PremiumRegistrationPrice="0" IcannFee="0" EapFee="0"/>
<DomainCheckResult Domain="fancy.xyz" Available="true" ErrorNo="0" Description="" IsPremiumName="true" PremiumRegistrationPrice="13000.0000" PremiumRenewalPrice="13000.0000" IcannFee="0.0000" EapFee="0.0000"/>
</CommandResponse>
</ApiResponse>`;

  const GETLIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ApiResponse xmlns="http://api.namecheap.com/xml.response" Status="OK">
<Errors/>
<RequestedCommand>namecheap.domains.getList</RequestedCommand>
<CommandResponse Type="namecheap.domains.getList">
<DomainGetListResult>
<Domain ID="127" Name="domain1.com" User="owner" Created="02/15/2026" Expires="02/15/2027" IsExpired="false" IsLocked="false" AutoRenew="false" WhoisGuard="ENABLED" IsPremium="false" IsOurDNS="true"/>
</DomainGetListResult>
<Paging><TotalItems>1</TotalItems><CurrentPage>1</CurrentPage><PageSize>20</PageSize></Paging>
</CommandResponse>
</ApiResponse>`;

  const GETHOSTS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ApiResponse xmlns="http://api.namecheap.com/xml.response" Status="OK">
<Errors/>
<RequestedCommand>namecheap.domains.dns.getHosts</RequestedCommand>
<CommandResponse Type="namecheap.domains.dns.getHosts">
<DomainDNSGetHostsResult Domain="domain1.com" IsUsingOurDNS="true">
<Host HostId="12" Name="@" Type="A" Address="76.76.21.21" MXPref="10" TTL="1800"/>
<Host HostId="14" Name="www" Type="CNAME" Address="cname.vercel-dns.com" MXPref="10" TTL="1800"/>
</DomainDNSGetHostsResult>
</CommandResponse>
</ApiResponse>`;

  const SETHOSTS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ApiResponse xmlns="http://api.namecheap.com/xml.response" Status="OK">
<Errors/>
<RequestedCommand>namecheap.domains.dns.setHosts</RequestedCommand>
<CommandResponse Type="namecheap.domains.dns.setHosts">
<DomainDNSSetHostsResult Domain="domain1.com" IsSuccess="true"/>
</CommandResponse>
</ApiResponse>`;

  const CREATE_XML = `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse xmlns="http://api.namecheap.com/xml.response" Status="OK">
<Errors/>
<RequestedCommand>namecheap.domains.create</RequestedCommand>
<CommandResponse Type="namecheap.domains.create">
<DomainCreateResult Domain="fancy.xyz" Registered="true" ChargedAmount="10.87" DomainID="9007" OrderID="196074" TransactionID="380716" WhoisguardEnable="false" NonRealTimeDomain="false"/>
</CommandResponse>
</ApiResponse>`;

  function writeRegistrantConfig(store: Store) {
    writeFileSync(
      store.paths.config,
      [
        "namecheap:",
        "  registrant:",
        "    first_name: Test",
        "    last_name: User",
        "    address1: 123 Main St",
        "    city: Anytown",
        "    state_province: CA",
        '    postal_code: "12345"',
        "    country: US",
        '    phone: "+1.5551234567"',
        "    email_address: registrant@example.com",
        "",
      ].join("\n"),
    );
  }

  const IP_ERROR_XML = `<?xml version="1.0" encoding="utf-8"?>
<ApiResponse xmlns="http://api.namecheap.com/xml.response" Status="ERROR">
<Errors><Error Number="1011102">API Key is invalid or API access has not been enabled</Error></Errors>
<RequestedCommand>namecheap.domains.check</RequestedCommand>
</ApiResponse>`;

  it("checks domain availability with sandbox host, global params, and premium pricing parsed", async () => {
    const store = freshStore();
    seedAcme(store);
    fetchMock = vi.fn(withDashclawRoute(() => mockXml(CHECK_XML)));
    vi.stubGlobal("fetch", fetchMock);

    const res = await pa.checkDomainAvailability(store, { environment: "staging", domains: ["taken.com", "fancy.xyz"] });

    expect(res.status).toBe("ok");
    expect((res as any).data).toEqual([
      expect.objectContaining({ domain: "taken.com", available: false, premium: false }),
      expect.objectContaining({ domain: "fancy.xyz", available: true, premium: true, premiumRegistrationPrice: "13000.0000" }),
    ]);
    const [url] = providerCalls()[0]!;
    expect(url).toContain("https://api.sandbox.namecheap.com/xml.response?");
    expect(url).toContain("ApiUser=ncuser");
    expect(url).toContain("ApiKey=nc_dummy_key");
    expect(url).toContain("UserName=ncuser");
    expect(url).toContain("ClientIp=203.0.113.7");
    expect(url).toContain("Command=namecheap.domains.check");
    expect(url).toContain("DomainList=taken.com%2Cfancy.xyz");
  });

  it("uses the production host when NAMECHEAP_SANDBOX is not true", async () => {
    delete process.env.NAMECHEAP_SANDBOX;
    const store = freshStore();
    seedAcme(store);
    fetchMock = vi.fn(withDashclawRoute(() => mockXml(CHECK_XML)));
    vi.stubGlobal("fetch", fetchMock);

    const res = await pa.checkDomainAvailability(store, { environment: "staging", domains: ["taken.com"] });

    expect(res.status).toBe("ok");
    expect(providerCalls()[0]![0]).toContain("https://api.namecheap.com/xml.response?");
  });

  it("lists domains with names and expiry parsed from XML", async () => {
    const store = freshStore();
    seedAcme(store);
    fetchMock = vi.fn(withDashclawRoute(() => mockXml(GETLIST_XML)));
    vi.stubGlobal("fetch", fetchMock);

    const res = await pa.namecheapListDomains(store, { environment: "staging" });

    expect(res.status).toBe("ok");
    expect((res as any).data).toEqual([
      expect.objectContaining({ name: "domain1.com", expires: "02/15/2027", autoRenew: false }),
    ]);
    expect(providerCalls()[0]![0]).toContain("Command=namecheap.domains.getList");
  });

  it("gets DNS host records parsed from XML", async () => {
    const store = freshStore();
    seedAcme(store);
    fetchMock = vi.fn(withDashclawRoute(() => mockXml(GETHOSTS_XML)));
    vi.stubGlobal("fetch", fetchMock);

    const res = await pa.getDnsRecords(store, { environment: "staging", domain: "domain1.com" });

    expect(res.status).toBe("ok");
    expect((res as any).data).toMatchObject({
      domain: "domain1.com",
      records: [
        { name: "@", type: "A", address: "76.76.21.21", ttl: 1800 },
        { name: "www", type: "CNAME", address: "cname.vercel-dns.com", ttl: 1800 },
      ],
    });
    const [url] = providerCalls()[0]!;
    expect(url).toContain("Command=namecheap.domains.dns.getHosts");
    expect(url).toContain("SLD=domain1");
    expect(url).toContain("TLD=com");
  });

  it("sets DNS host records with numbered params and env_change capability", async () => {
    const store = freshStore();
    seedAcme(store);
    fetchMock = vi.fn(withDashclawRoute(() => mockXml(SETHOSTS_XML)));
    vi.stubGlobal("fetch", fetchMock);

    const res = await pa.setDnsRecords(store, {
      environment: "staging",
      domain: "domain1.com",
      records: [
        { name: "@", type: "A", address: "76.76.21.21" },
        { name: "www", type: "CNAME", address: "cname.vercel-dns.com", ttl: 300 },
      ],
    });

    expect(res.status).toBe("ok");
    const [url] = providerCalls()[0]!;
    expect(url).toContain("Command=namecheap.domains.dns.setHosts");
    expect(url).toContain("HostName1=%40");
    expect(url).toContain("RecordType1=A");
    expect(url).toContain("Address1=76.76.21.21");
    expect(url).toContain("HostName2=www");
    expect(url).toContain("RecordType2=CNAME");
    expect(url).toContain("TTL2=300");
    expect(lastAudit(store)).toMatchObject({ tool: "set_dns_records", result: "success" });
    // Capability env_change reaches the DashClaw guard payload.
    const guardBody = fetchMock.mock.calls.find(([u]: [string]) => u === "https://dashclaw.example/api/guard")?.[1]?.body;
    expect(String(guardBody)).toContain('"capability":"env_change"');
  });

  it("requires approval for purchase_domain end-to-end even with an explicit allow policy", async () => {
    setDashclawDecision("require_approval", "purchase");
    const store = freshStore();
    seedAcme(store);
    writeRegistrantConfig(store);
    setPolicyRule(store, {
      effect: "allow",
      priority: 500,
      description: "Attempt to un-gate purchases (must be clamped).",
      match: { capability: "purchase" },
    });

    const res = await pa.purchaseDomain(store, { environment: "production", domain: "fancy.xyz" });

    expect(res.status).toBe("approval_required");
    expect(providerCalls()).toHaveLength(0);
    // The clamped local preview travels to DashClaw: approval_required despite the allow rule.
    const guardBody = String(
      fetchMock.mock.calls.find(([u]: [string]) => u === "https://dashclaw.example/api/guard")?.[1]?.body,
    );
    expect(guardBody).toContain('"capability":"purchase"');
    expect(guardBody).toContain('"local_policy_effect":"approval_required"');
    expect(lastAudit(store)).toMatchObject({ tool: "purchase_domain", result: "not_executed" });
  });

  it("sends registrant contact fields on an approved purchase", async () => {
    const store = freshStore();
    seedAcme(store);
    writeRegistrantConfig(store);
    fetchMock = vi.fn(withDashclawRoute(() => mockXml(CREATE_XML)));
    vi.stubGlobal("fetch", fetchMock);

    const res = await pa.purchaseDomain(store, { environment: "production", domain: "fancy.xyz", years: 1 });

    expect(res.status).toBe("ok");
    expect((res as any).data).toMatchObject({ domain: "fancy.xyz", registered: true, chargedAmount: "10.87" });
    const [url] = providerCalls()[0]!;
    expect(url).toContain("Command=namecheap.domains.create");
    expect(url).toContain("DomainName=fancy.xyz");
    expect(url).toContain("Years=1");
    expect(url).toContain("RegistrantFirstName=Test");
    expect(url).toContain("RegistrantEmailAddress=registrant%40example.com");
    expect(url).toContain("TechFirstName=Test");
    expect(url).toContain("AdminFirstName=Test");
    expect(url).toContain("AuxBillingFirstName=Test");
    expect(lastAudit(store)).toMatchObject({ tool: "purchase_domain", result: "success" });
  });

  it("fails actionably before any HTTP when registrant contact config is missing", async () => {
    const store = freshStore();
    seedAcme(store);

    await expect(
      pa.purchaseDomain(store, { environment: "production", domain: "fancy.xyz" }),
    ).rejects.toThrow(/namecheap\.registrant/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps error 1011102 to a re-whitelist-your-IP message", async () => {
    const store = freshStore();
    seedAcme(store);
    fetchMock = vi.fn(withDashclawRoute(() => mockXml(IP_ERROR_XML)));
    vi.stubGlobal("fetch", fetchMock);

    const res = await pa.checkDomainAvailability(store, { environment: "staging", domains: ["taken.com"] });

    expect(res.status).toBe("error");
    expect((res as any).error).toMatch(/whitelist/i);
    expect((res as any).error).toMatch(/public IP/i);
    expect((res as any).error).toMatch(/1011102/);
  });

  it("surfaces generic Namecheap errors with code and text", async () => {
    const store = freshStore();
    seedAcme(store);
    const GENERIC_ERROR_XML = IP_ERROR_XML.replace("1011102", "2030280").replace(
      "API Key is invalid or API access has not been enabled",
      "TLD is not supported in API",
    );
    fetchMock = vi.fn(withDashclawRoute(() => mockXml(GENERIC_ERROR_XML)));
    vi.stubGlobal("fetch", fetchMock);

    const res = await pa.checkDomainAvailability(store, { environment: "staging", domains: ["x.weirdtld"] });

    expect(res.status).toBe("error");
    expect((res as any).error).toMatch(/2030280/);
    expect((res as any).error).toMatch(/TLD is not supported/i);
  });
});

describe("Neon", () => {
  // Obviously-fake fixture URI: placeholder credentials only, never a real secret.
  const NEON_URI =
    "postgresql://neondb_owner:test-placeholder-password@ep-test-123.us-east-1.aws.neon.tech/neondb?sslmode=require";

  beforeEach(() => {
    process.env.NEON_API_KEY = "neon_dummy";
  });

  afterEach(() => {
    delete process.env.NEON_API_KEY;
  });

  function dashclawBodies(): string {
    return fetchMock.mock.calls
      .filter(([url]) => typeof url === "string" && url.startsWith("https://dashclaw.example"))
      .map(([, init]) => String(init?.body ?? ""))
      .join(" ");
  }

  it("lists Neon projects with Bearer auth against the v2 API", async () => {
    const store = freshStore();
    seedAcme(store);
    fetchMock = vi.fn(
      withDashclawRoute(() =>
        mockOk({
          projects: [
            { id: "proj-1", name: "acme-db", region_id: "aws-us-east-1", pg_version: 17, created_at: "2026-06-10T00:00:00Z" },
          ],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await pa.neonListProjects(store, { environment: "staging" });

    expect(res.status).toBe("ok");
    expect((res as any).data).toEqual([
      { id: "proj-1", name: "acme-db", regionId: "aws-us-east-1", pgVersion: 17, createdAt: "2026-06-10T00:00:00Z" },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://console.neon.tech/api/v2/projects",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer neon_dummy" }),
      }),
    );
  });

  it("creates a Neon project with the right body and returns the connection URI exactly once", async () => {
    const store = freshStore();
    seedAcme(store);
    fetchMock = vi.fn(
      withDashclawRoute(() =>
        mockOk({
          project: { id: "proj-new", name: "acme-db", region_id: "aws-us-east-1", pg_version: 17 },
          branch: { id: "br-1" },
          connection_uris: [{ connection_uri: NEON_URI }],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await pa.neonCreateProject(store, { environment: "staging", name: "acme-db" });

    expect(res.status).toBe("ok");
    const [url, init] = providerCalls()[0]!;
    expect(url).toBe("https://console.neon.tech/api/v2/projects");
    expect(JSON.parse(init.body)).toMatchObject({ project: { name: "acme-db" } });
    expect((res as any).data).toMatchObject({
      project: { id: "proj-new", name: "acme-db" },
      branchId: "br-1",
      connectionUri: NEON_URI,
    });
    // The URI reaches the calling agent exactly once, in the tool result only.
    expect(JSON.stringify(res).split(NEON_URI)).toHaveLength(2);
  });

  it("returns the connection URI for a project via query params", async () => {
    const store = freshStore();
    seedAcme(store);
    fetchMock = vi.fn(withDashclawRoute(() => mockOk({ connection_uri: NEON_URI })));
    vi.stubGlobal("fetch", fetchMock);

    const res = await pa.neonGetConnectionUri(store, {
      environment: "staging",
      neonProjectId: "proj-new",
      databaseName: "neondb",
      roleName: "neondb_owner",
    });

    expect(res.status).toBe("ok");
    expect((res as any).data).toMatchObject({ connectionUri: NEON_URI });
    const [url] = providerCalls()[0]!;
    expect(url).toContain("https://console.neon.tech/api/v2/projects/proj-new/connection_uri?");
    expect(url).toContain("database_name=neondb");
    expect(url).toContain("role_name=neondb_owner");
  });

  it("keeps the connection URI out of audit entries and DashClaw payloads", async () => {
    const store = freshStore();
    seedAcme(store);
    fetchMock = vi.fn(
      withDashclawRoute((url) =>
        url.endsWith("/connection_uri") || url.includes("/connection_uri?")
          ? mockOk({ connection_uri: NEON_URI })
          : mockOk({
              project: { id: "proj-new", name: "acme-db" },
              branch: { id: "br-1" },
              connection_uris: [{ connection_uri: NEON_URI }],
            }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const created = await pa.neonCreateProject(store, { environment: "staging", name: "acme-db" });
    const fetched = await pa.neonGetConnectionUri(store, {
      environment: "staging",
      neonProjectId: "proj-new",
      databaseName: "neondb",
      roleName: "neondb_owner",
    });

    expect(created.status).toBe("ok");
    expect(fetched.status).toBe("ok");
    // Both audit entries exist and neither carries the URI or its credentials.
    const audit = listAuditLog(store, { project: "acme-crm" });
    expect(audit.filter((e) => e.tool === "create_neon_project")).toHaveLength(1);
    expect(audit.filter((e) => e.tool === "get_neon_connection_uri")).toHaveLength(1);
    const auditJson = JSON.stringify(audit);
    expect(auditJson).not.toContain("postgres");
    expect(auditJson).not.toContain("test-placeholder-password");
    // No DashClaw guard/outcome payload contains the URI or its credentials.
    const bodies = dashclawBodies();
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies).not.toContain("postgres://");
    expect(bodies).not.toContain("postgresql://");
    expect(bodies).not.toContain("test-placeholder-password");
  });
});

describe("Vercel", () => {
  it("uses the mapping connection token and team scope for Vercel calls", async () => {
    const store = freshStore();
    seedAcme(store);
    process.env.CUSTOM_VERCEL_TOKEN = "vc_custom";
    store.update((s) => {
      s.connections.push({
        id: "conn_custom_vercel",
        workspaceId: s.defaultWorkspaceId!,
        provider: "vercel",
        label: "custom-vercel",
        auth: { kind: "env", envVar: "CUSTOM_VERCEL_TOKEN" },
        scope: { vercelTeamId: "team_custom" },
        createdAt: new Date().toISOString(),
      });
    });
    mapProviderResource(store, {
      environment: "staging",
      provider: "vercel",
      connectionId: "conn_custom_vercel",
      resource: { provider: "vercel", projectId: "acme-preview" },
    });
    fetchMock.mockResolvedValueOnce(mockOk({ deployments: [] }));

    const res = await pa.vercelDeployments(store, { environment: "staging", limit: 3 });

    expect(res.status).toBe("ok");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("https://api.vercel.com/v7/deployments?teamId=team_custom"),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer vc_custom" }),
      }),
    );
  });

  it("rejects invalid deployment list limits before calling Vercel", async () => {
    const store = freshStore();
    seedAcme(store);
    const res = await pa.vercelDeployments(store, { environment: "staging", limit: -1 });
    expect(res.status).toBe("error");
    expect((res as any).error).toMatch(/limit/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates a Vercel project against v11 with capability write", async () => {
    const store = freshStore();
    seedAcme(store);
    fetchMock = vi.fn(withDashclawRoute(() => mockOk({ id: "prj_new", name: "acme-site", framework: "nextjs" })));
    vi.stubGlobal("fetch", fetchMock);

    const res = await pa.vercelCreateProject(store, { environment: "staging", name: "acme-site", framework: "nextjs" });

    expect(res.status).toBe("ok");
    const [url, init] = providerCalls()[0]!;
    expect(url).toContain("https://api.vercel.com/v11/projects");
    expect(JSON.parse(init.body)).toMatchObject({ name: "acme-site", framework: "nextjs" });
    expect((res as any).data).toMatchObject({ id: "prj_new", name: "acme-site" });
    const guardBody = String(
      fetchMock.mock.calls.find(([u]: [string]) => u === "https://dashclaw.example/api/guard")?.[1]?.body,
    );
    expect(guardBody).toContain('"capability":"write"');
  });

  it("adds an apex domain to a Vercel project and returns A-record DNS target info", async () => {
    const store = freshStore();
    seedAcme(store);
    fetchMock = vi.fn(
      withDashclawRoute(() =>
        mockOk({
          name: "example.com",
          apexName: "example.com",
          projectId: "prj_new",
          verified: false,
          verification: [
            { type: "TXT", domain: "_vercel.example.com", value: "vc-domain-verify=example", reason: "pending" },
          ],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await pa.vercelAddDomain(store, { environment: "staging", vercelProject: "prj_new", domain: "example.com" });

    expect(res.status).toBe("ok");
    const [url, init] = providerCalls()[0]!;
    expect(url).toContain("/v10/projects/prj_new/domains");
    expect(JSON.parse(init.body)).toMatchObject({ name: "example.com" });
    expect((res as any).data).toMatchObject({
      name: "example.com",
      verified: false,
      dnsTarget: { type: "A", host: "@", value: "76.76.21.21" },
      verification: [expect.objectContaining({ type: "TXT" })],
    });
  });

  it("returns CNAME DNS target info for a subdomain", async () => {
    const store = freshStore();
    seedAcme(store);
    fetchMock = vi.fn(
      withDashclawRoute(() =>
        mockOk({ name: "www.example.com", apexName: "example.com", projectId: "prj_new", verified: true }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await pa.vercelAddDomain(store, {
      environment: "staging",
      vercelProject: "prj_new",
      domain: "www.example.com",
    });

    expect(res.status).toBe("ok");
    expect((res as any).data).toMatchObject({
      name: "www.example.com",
      dnsTarget: { type: "CNAME", host: "www", value: "cname.vercel-dns.com" },
    });
  });

  it("requires approval for production deploys and does NOT execute them", async () => {
    setDashclawDecision("require_approval", "vercel_prod_deploy");
    const store = freshStore();
    seedAcme(store);
    const res = await pa.vercelCreateDeployment(store, { environment: "production" });
    expect(res.status).toBe("approval_required");
    expect((res as any).approval_id).toBe("act_vercel_prod_deploy");
    expect(providerCalls()).toHaveLength(0);
    expect(listPendingApprovals(store, { project: "acme-crm" })).toHaveLength(0);
  });

  it("executes a production deploy when DashClaw allows it", async () => {
    const store = freshStore();
    seedAcme(store);

    const res = await pa.vercelCreateDeployment(store, { environment: "production" });

    expect(res.status).toBe("ok");
    expect(providerCalls()).toHaveLength(1);
    expect(listPendingApprovals(store, { project: "acme-crm" })).toHaveLength(0);
    expect(lastAudit(store)).toMatchObject({
      result: "success",
      policyDecision: "allow",
      dashclawDecisionId: "gd_allow",
      dashclawActionId: "act_allow",
      auditCorrelationId: expect.stringMatching(/^audit_/),
    });
    expect((res as any).dashclaw).toMatchObject({ outcome_recorded: true });
  });

  it("keeps production deploys gated while DashClaw requires approval", async () => {
    setDashclawDecision("require_approval", "vercel_retry");
    const store = freshStore();
    seedAcme(store);
    const gated = await pa.vercelCreateDeployment(store, { environment: "production" });
    expect(gated.status).toBe("approval_required");

    const rerun = await pa.vercelCreateDeployment(store, { environment: "production" });
    expect(rerun.status).toBe("approval_required");
    expect((rerun as any).approval_id).toBe("act_vercel_retry");
    expect(providerCalls()).toHaveLength(0);
    expect(listPendingApprovals(store, { project: "acme-crm" })).toHaveLength(0);
  });

  it("requires approval for production env-var changes", async () => {
    setDashclawDecision("require_approval", "vercel_env");
    const store = freshStore();
    seedAcme(store);
    const res = await pa.vercelSetEnvVar(store, {
      environment: "production",
      key: "DATABASE_URL",
      value: "postgres://...",
    });
    expect(res.status).toBe("approval_required");
    expect(providerCalls()).toHaveLength(0);
  });

  it("rejects empty env-var keys before calling Vercel", async () => {
    const store = freshStore();
    seedAcme(store);
    const res = await pa.vercelSetEnvVar(store, {
      environment: "staging",
      key: "   ",
      value: "value",
    });
    expect(res.status).toBe("error");
    expect((res as any).error).toMatch(/key/i);
    expect(providerCalls()).toHaveLength(0);
  });

  it("allows and executes a non-production (preview) deploy", async () => {
    const store = freshStore();
    seedAcme(store);
    const res = await pa.vercelCreateDeployment(store, { environment: "staging" });
    expect(res.status).toBe("ok");
    expect(providerCalls()).toHaveLength(1);
  });

  it("does not execute an allowed provider action when the audit log cannot be reserved", async () => {
    const store = freshStore();
    seedAcme(store);
    mkdirSync(`${store.paths.audit}.lock`);

    const res = await pa.vercelCreateDeployment(store, { environment: "staging" });

    expect(res.status).toBe("error");
    expect(res.executed).toBe(false);
    expect((res as any).error).toMatch(/audit/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("App logs", () => {
  /** Route a mocked fetch by URL to the right Vercel endpoint payload. */
  function routeVercel(opts: { deployments?: any[]; events?: any[]; status?: any }) {
    return (url: string) => {
      if (url.includes("/v7/deployments")) return mockOk({ deployments: opts.deployments ?? [] });
      if (/\/v3\/deployments\/[^/]+\/events/.test(url)) return mockOk(opts.events ?? []);
      if (url.includes("/v13/deployments/")) return mockOk(opts.status ?? {});
      return mockOk({});
    };
  }

  const LATEST = { uid: "dpl_123", url: "acme.vercel.app", readyState: "ERROR", state: "ERROR", created: 1700000000000 };

  it("get_vercel_logs resolves the latest deployment and returns normalized logs", async () => {
    const store = freshStore();
    seedAcme(store);
    fetchMock.mockImplementation(async (url: string) =>
      routeVercel({
        deployments: [LATEST],
        events: [
          { type: "stdout", created: 1700000001000, text: "Building..." },
          { type: "stderr", created: 1700000002000, text: "Error: DATABASE_URL is missing" },
        ],
      })(url),
    );

    const res = await pa.vercelLogs(store, { environment: "staging" });
    expect(res.status).toBe("ok");
    const data = (res as any).data;
    expect(data.resource.deployment_id).toBe("dpl_123");
    expect(data.resource.deployment_status).toBe("ERROR");
    expect(data.resource.deployment_url).toBe("https://acme.vercel.app");
    expect(data.logs).toHaveLength(2);
    expect(data.logs[1]).toMatchObject({ level: "error", message: "Error: DATABASE_URL is missing" });
    expect(data.audit_written).toBe(true);
    expect(lastAudit(store)).toMatchObject({ result: "success", policyDecision: "allow", provider: "vercel", tool: "get_vercel_logs" });
  });

  it("redacts secrets that appear in log lines", async () => {
    const store = freshStore();
    seedAcme(store);
    fetchMock.mockImplementation(async (url: string) =>
      routeVercel({
        deployments: [LATEST],
        events: [{ type: "stdout", created: 1700000001000, text: "Using key sk_live_ABCDEFGH123456789" }],
      })(url),
    );
    const res = await pa.vercelLogs(store, { environment: "staging" });
    const msg = (res as any).data.logs[0].message;
    expect(msg).not.toContain("sk_live_ABCDEFGH123456789");
    expect(msg).toContain("REDACTED");
  });

  it("returns a limitation (not an error) when the events API yields no logs", async () => {
    const store = freshStore();
    seedAcme(store);
    fetchMock.mockImplementation(async (url: string) => routeVercel({ deployments: [LATEST], events: [] })(url));
    const res = await pa.vercelLogs(store, { environment: "staging" });
    expect(res.status).toBe("ok");
    const data = (res as any).data;
    expect(data.logs).toHaveLength(0);
    expect(typeof data.limitation).toBe("string");
  });

  it("rejects invalid since filters before calling Vercel", async () => {
    const store = freshStore();
    seedAcme(store);
    const res = await pa.vercelLogs(store, { environment: "staging", since: "not a timestamp" });
    expect(res.status).toBe("error");
    expect((res as any).error).toMatch(/since/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("get_app_logs with no provider discovers the mapped Vercel project and audits the read", async () => {
    const store = freshStore();
    seedAcme(store);
    fetchMock.mockImplementation(async (url: string) =>
      routeVercel({ deployments: [LATEST], events: [{ type: "stdout", created: 1700000001000, text: "ok" }] })(url),
    );
    const res = await pa.appLogs(store, { environment: "staging" });
    expect(res.status).toBe("ok");
    expect(res.providers).toHaveLength(1);
    expect((res.providers[0] as any).provider).toBe("vercel");
    expect(lastAudit(store)).toMatchObject({ result: "success", provider: "vercel", tool: "get_app_logs" });
  });

  it("get_latest_deployment_logs returns a clear limitation for unsupported providers", async () => {
    const store = freshStore();
    seedAcme(store);
    const res = await pa.latestDeploymentLogs(store, { environment: "staging", provider: "supabase" });
    expect(res.status).toBe("ok");
    expect((res as any).data.limitation).toMatch(/not supported/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Railway logs", () => {
  function mapRailway(store: Store) {
    mapProviderResource(store, {
      project: "acme-crm",
      environment: "staging",
      provider: "railway",
      resource: { provider: "railway", projectId: "rw_proj_1", environmentId: "rw_env_1", serviceId: "rw_svc_1" },
    });
  }

  /** Route a mocked fetch (GraphQL POST) by inspecting the query body. */
  function routeRailway(opts: { project?: any; deployments?: any[]; logs?: any[]; errors?: any[] }) {
    return (_url: string, init?: any) => {
      if (opts.errors) return mockOk({ errors: opts.errors });
      const q = init?.body ? JSON.parse(init.body).query ?? "" : "";
      if (q.includes("deploymentLogs")) return mockOk({ data: { deploymentLogs: opts.logs ?? [] } });
      if (q.includes("deployments(")) {
        return mockOk({ data: { deployments: { edges: (opts.deployments ?? []).map((node) => ({ node })) } } });
      }
      if (q.includes("project(")) return mockOk({ data: { project: opts.project ?? null } });
      return mockOk({ data: {} });
    };
  }

  const RW_LATEST = { id: "rw_dpl_1", status: "FAILED", staticUrl: "acme.up.railway.app", createdAt: "2026-06-09T12:00:00Z" };

  beforeEach(() => {
    process.env.RAILWAY_TOKEN = "rw_dummy";
  });

  it("get_railway_logs resolves the latest deployment and normalizes severity", async () => {
    const store = freshStore();
    seedAcme(store);
    mapRailway(store);
    fetchMock.mockImplementation(async (url: string, init: any) =>
      routeRailway({
        deployments: [RW_LATEST],
        logs: [
          { timestamp: "2026-06-09T12:00:01Z", severity: "info", message: "Starting container" },
          { timestamp: "2026-06-09T12:00:02Z", severity: "err", message: "Boom: missing DATABASE_URL" },
        ],
      })(url, init),
    );

    const res = await pa.railwayLogs(store, { environment: "staging" });
    expect(res.status).toBe("ok");
    const data = (res as any).data;
    expect(data.resource.deployment_id).toBe("rw_dpl_1");
    expect(data.resource.deployment_status).toBe("FAILED");
    expect(data.resource.deployment_url).toBe("https://acme.up.railway.app");
    expect(data.logs).toHaveLength(2);
    expect(data.logs[1]).toMatchObject({ level: "error", message: "Boom: missing DATABASE_URL" });
    expect(lastAudit(store)).toMatchObject({ result: "success", provider: "railway", tool: "get_railway_logs" });
  });

  it("rejects invalid log limits before calling Railway", async () => {
    const store = freshStore();
    seedAcme(store);
    mapRailway(store);
    const res = await pa.railwayLogs(store, { environment: "staging", limit: -5 });
    expect(res.status).toBe("error");
    expect((res as any).error).toMatch(/limit/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects invalid since filters before calling Railway", async () => {
    const store = freshStore();
    seedAcme(store);
    mapRailway(store);
    const res = await pa.railwayLogs(store, { environment: "staging", since: "not a timestamp" });
    expect(res.status).toBe("error");
    expect((res as any).error).toMatch(/since/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("get_app_logs with no provider reads BOTH vercel and railway (vercel first)", async () => {
    const store = freshStore();
    seedAcme(store);
    mapRailway(store);
    fetchMock.mockImplementation(async (url: string, init: any) => {
      if (url.includes("backboard.railway")) {
        return routeRailway({ deployments: [RW_LATEST], logs: [{ timestamp: "t", severity: "info", message: "rw" }] })(url, init);
      }
      // Vercel REST
      if (url.includes("/v7/deployments")) return mockOk({ deployments: [{ uid: "vc_1", url: "v.app", readyState: "READY", created: 1 }] });
      if (/\/v3\/deployments\/[^/]+\/events/.test(url)) return mockOk([{ type: "stdout", created: 1, text: "vc" }]);
      return mockOk({});
    });

    const res = await pa.appLogs(store, { environment: "staging" });
    expect(res.status).toBe("ok");
    expect(res.providers.map((p: any) => p.provider)).toEqual(["vercel", "railway"]);
  });

  it("get_latest_deployment_logs works for provider=railway", async () => {
    const store = freshStore();
    seedAcme(store);
    mapRailway(store);
    fetchMock.mockImplementation(async (url: string, init: any) =>
      routeRailway({ deployments: [RW_LATEST], logs: [] })(url, init),
    );
    const res = await pa.latestDeploymentLogs(store, { environment: "staging", provider: "railway" });
    expect(res.status).toBe("ok");
    expect((res as any).data.resource.deployment_id).toBe("rw_dpl_1");
    // No log lines -> a clear limitation, still ok + audited.
    expect((res as any).data.limitation).toBeTruthy();
    expect(lastAudit(store)).toMatchObject({ provider: "railway", tool: "get_latest_deployment_logs", result: "success" });
  });

  it("surfaces a GraphQL error as a clean error envelope", async () => {
    const store = freshStore();
    seedAcme(store);
    mapRailway(store);
    fetchMock.mockImplementation(async (url: string, init: any) =>
      routeRailway({ errors: [{ message: "Not Authorized" }] })(url, init),
    );
    const res = await pa.railwayDeployments(store, { environment: "staging" });
    expect(res.status).toBe("error");
    expect((res as any).error).toMatch(/Not Authorized/);
  });
});

describe("Railway writes", () => {
  function mapRailwayTo(store: Store, environment: string) {
    mapProviderResource(store, {
      project: "acme-crm",
      environment,
      provider: "railway",
      resource: { provider: "railway", projectId: "rw_proj_1", environmentId: "rw_env_1", serviceId: "rw_svc_1" },
    });
  }

  function routeMutations() {
    return (_url: string, init?: any) => {
      const q = init?.body ? JSON.parse(init.body).query ?? "" : "";
      if (q.includes("environmentTriggersDeploy")) return mockOk({ data: { environmentTriggersDeploy: "rw_dpl_new" } });
      if (q.includes("deploymentRedeploy")) return mockOk({ data: { deploymentRedeploy: { id: "rw_dpl_re", status: "BUILDING" } } });
      if (q.includes("variableUpsert")) return mockOk({ data: { variableUpsert: true } });
      return mockOk({ data: {} });
    };
  }

  beforeEach(() => {
    process.env.RAILWAY_TOKEN = "rw_dummy";
  });

  it("allows and executes a staging deploy", async () => {
    const store = freshStore();
    seedAcme(store);
    mapRailwayTo(store, "staging");
    fetchMock.mockImplementation(withDashclawRoute((url: string, init: any) => routeMutations()(url, init)));
    const res = await pa.railwayCreateDeployment(store, { environment: "staging" });
    expect(res.status).toBe("ok");
    expect((res as any).data.deploymentId).toBe("rw_dpl_new");
    expect(providerCalls()).toHaveLength(1);
    expect(lastAudit(store)).toMatchObject({ result: "success", provider: "railway", tool: "create_railway_deployment" });
  });

  it("requires approval for a production deploy and does NOT execute", async () => {
    setDashclawDecision("require_approval", "railway_prod_deploy");
    const store = freshStore();
    seedAcme(store);
    mapRailwayTo(store, "production");
    fetchMock.mockImplementation(withDashclawRoute((url: string, init: any) => routeMutations()(url, init)));
    const res = await pa.railwayCreateDeployment(store, { environment: "production" });
    expect(res.status).toBe("approval_required");
    expect(providerCalls()).toHaveLength(0);
    expect(lastAudit(store)).toMatchObject({
      result: "not_executed",
      policyDecision: "approval_required",
      dashclawDecisionId: "gd_railway_prod_deploy",
      dashclawActionId: "act_railway_prod_deploy",
    });
  });

  it("requires approval for a production variable change and does NOT execute", async () => {
    setDashclawDecision("require_approval", "railway_prod_var");
    const store = freshStore();
    seedAcme(store);
    mapRailwayTo(store, "production");
    fetchMock.mockImplementation(withDashclawRoute((url: string, init: any) => routeMutations()(url, init)));
    const res = await pa.railwaySetEnvVar(store, { environment: "production", key: "DATABASE_URL", value: "postgres://..." });
    expect(res.status).toBe("approval_required");
    expect(providerCalls()).toHaveLength(0);
  });

  it("allows and executes a staging variable change", async () => {
    const store = freshStore();
    seedAcme(store);
    mapRailwayTo(store, "staging");
    fetchMock.mockImplementation(withDashclawRoute((url: string, init: any) => routeMutations()(url, init)));
    const res = await pa.railwaySetEnvVar(store, { environment: "staging", key: "FEATURE_FLAG", value: "on" });
    expect(res.status).toBe("ok");
    expect(providerCalls()).toHaveLength(1);
    const body = JSON.parse((providerCalls()[0]![1] as RequestInit).body as string);
    expect(body.variables.input).toMatchObject({ name: "FEATURE_FLAG", value: "on", environmentId: "rw_env_1" });
  });

  it("rejects empty variable keys before calling Railway", async () => {
    const store = freshStore();
    seedAcme(store);
    mapRailwayTo(store, "staging");
    fetchMock.mockImplementation(withDashclawRoute((url: string, init: any) => routeMutations()(url, init)));
    const res = await pa.railwaySetEnvVar(store, { environment: "staging", key: " ", value: "on" });
    expect(res.status).toBe("error");
    expect((res as any).error).toMatch(/key/i);
    expect(providerCalls()).toHaveLength(0);
  });
});

describe("Supabase", () => {
  it("blocks destructive SQL everywhere and does NOT execute", async () => {
    setDashclawDecision("block", "supabase_destructive");
    const store = freshStore();
    seedAcme(store);
    const res = await pa.supabaseQuery(store, { environment: "staging", sql: "DROP TABLE users" });
    expect(res.status).toBe("blocked");
    expect(providerCalls()).toHaveLength(0);
    expect(lastAudit(store)).toMatchObject({
      result: "not_executed",
      policyDecision: "block",
      dashclawDecisionId: "gd_supabase_destructive",
      dashclawActionId: "act_supabase_destructive",
    });
  });

  it("requires approval for a production DB write and does NOT execute", async () => {
    setDashclawDecision("require_approval", "supabase_prod_write");
    const store = freshStore();
    seedAcme(store);
    const res = await pa.supabaseQuery(store, {
      environment: "production",
      sql: "INSERT INTO users (id) VALUES (1)",
    });
    expect(res.status).toBe("approval_required");
    expect(providerCalls()).toHaveLength(0);
  });

  it("allows a read-only SELECT and sends read_only=true", async () => {
    const store = freshStore();
    seedAcme(store);
    fetchMock.mockResolvedValueOnce(mockOk([{ count: 5 }]));
    const res = await pa.supabaseQuery(store, { environment: "production", sql: "SELECT count(*) FROM users" });
    expect(res.status).toBe("ok");
    expect(providerCalls()).toHaveLength(1);
    const body = JSON.parse((providerCalls()[0]![1] as RequestInit).body as string);
    expect(body.read_only).toBe(true);
  });

  it("rejects empty SQL before calling Supabase", async () => {
    const store = freshStore();
    seedAcme(store);
    const res = await pa.supabaseQuery(store, { environment: "staging", sql: "   " });
    expect(res.status).toBe("error");
    expect((res as any).error).toMatch(/sql/i);
    expect(providerCalls()).toHaveLength(0);
  });
});

describe("Stripe webhooks", () => {
  // Built via concatenation so no secret-shaped literal sits in the repo.
  const FAKE_WHSEC = ["whsec", "testplaceholder123"].join("_");

  it("creates a webhook endpoint with indexed enabled_events and returns the signing secret once", async () => {
    const store = freshStore();
    seedAcme(store);
    fetchMock = vi.fn(
      withDashclawRoute(() =>
        mockOk({
          id: "we_1",
          url: "https://example.com/api/stripe/webhook",
          enabled_events: ["checkout.session.completed", "invoice.paid"],
          status: "enabled",
          secret: FAKE_WHSEC,
          created: 1,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await pa.stripeCreateWebhook(store, {
      environment: "staging",
      url: "https://example.com/api/stripe/webhook",
      enabledEvents: ["checkout.session.completed", "invoice.paid"],
    });

    expect(res.status).toBe("ok");
    const [url, init] = providerCalls()[0]!;
    expect(url).toBe("https://api.stripe.com/v1/webhook_endpoints");
    expect(init.body).toContain("enabled_events%5B0%5D=checkout.session.completed");
    expect(init.body).toContain("enabled_events%5B1%5D=invoice.paid");
    expect((res as any).data).toMatchObject({ id: "we_1", secret: FAKE_WHSEC });
    // Secret appears exactly once, in the tool result only.
    expect(JSON.stringify(res).split(FAKE_WHSEC)).toHaveLength(2);
    // Capability write reaches the DashClaw guard payload.
    const guardBody = String(
      fetchMock.mock.calls.find(([u]: [string]) => u === "https://dashclaw.example/api/guard")?.[1]?.body,
    );
    expect(guardBody).toContain('"capability":"write"');
  });

  it("keeps the webhook signing secret out of audit entries and DashClaw payloads", async () => {
    const store = freshStore();
    seedAcme(store);
    fetchMock = vi.fn(
      withDashclawRoute(() =>
        mockOk({ id: "we_1", url: "https://example.com/api/stripe/webhook", secret: FAKE_WHSEC, created: 1 }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await pa.stripeCreateWebhook(store, {
      environment: "staging",
      url: "https://example.com/api/stripe/webhook",
      enabledEvents: ["checkout.session.completed"],
    });

    expect(res.status).toBe("ok");
    const audit = listAuditLog(store, { project: "acme-crm" });
    expect(audit.filter((e) => e.tool === "create_stripe_webhook")).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain("whsec");
    const dashclawBodies = fetchMock.mock.calls
      .filter(([u]: [string]) => typeof u === "string" && u.startsWith("https://dashclaw.example"))
      .map(([, init]: [string, any]) => String(init?.body ?? ""))
      .join(" ");
    expect(dashclawBodies.length).toBeGreaterThan(0);
    expect(dashclawBodies).not.toContain("whsec");
  });

  it("lists webhook endpoints", async () => {
    const store = freshStore();
    seedAcme(store);
    fetchMock = vi.fn(
      withDashclawRoute(() =>
        mockOk({
          data: [
            { id: "we_1", url: "https://example.com/api/stripe/webhook", status: "enabled", enabled_events: ["invoice.paid"], created: 1 },
          ],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const res = await pa.stripeListWebhooks(store, { environment: "staging" });

    expect(res.status).toBe("ok");
    expect((res as any).data).toEqual([
      expect.objectContaining({ id: "we_1", url: "https://example.com/api/stripe/webhook", status: "enabled" }),
    ]);
    expect(providerCalls()[0]![0]).toContain("https://api.stripe.com/v1/webhook_endpoints");
  });
});

describe("missing-credential error messages name the exact env var", () => {
  it("Neon actions name NEON_API_KEY", async () => {
    const store = freshStore();
    seedAcme(store);

    const res = await pa.neonListProjects(store, { environment: "staging" });

    expect(res.status).toBe("error");
    expect((res as any).error).toMatch(/NEON_API_KEY/);
  });

  it("Namecheap actions name NAMECHEAP_API_KEY when the key is missing", async () => {
    const store = freshStore();
    seedAcme(store);

    const res = await pa.checkDomainAvailability(store, { environment: "staging", domains: ["example.com"] });

    expect(res.status).toBe("error");
    expect((res as any).error).toMatch(/NAMECHEAP_API_KEY/);
  });

  it("Namecheap actions name NAMECHEAP_API_USER when only the key is set", async () => {
    process.env.NAMECHEAP_API_KEY = "nc_dummy_key";
    try {
      const store = freshStore();
      seedAcme(store);

      const res = await pa.checkDomainAvailability(store, { environment: "staging", domains: ["example.com"] });

      expect(res.status).toBe("error");
      expect((res as any).error).toMatch(/NAMECHEAP_API_USER/);
    } finally {
      delete process.env.NAMECHEAP_API_KEY;
    }
  });

  it("Namecheap actions name NAMECHEAP_CLIENT_IP and the whitelist requirement", async () => {
    process.env.NAMECHEAP_API_KEY = "nc_dummy_key";
    process.env.NAMECHEAP_API_USER = "ncuser";
    try {
      const store = freshStore();
      seedAcme(store);

      const res = await pa.checkDomainAvailability(store, { environment: "staging", domains: ["example.com"] });

      expect(res.status).toBe("error");
      expect((res as any).error).toMatch(/NAMECHEAP_CLIENT_IP/);
      expect((res as any).error).toMatch(/whitelist/i);
    } finally {
      delete process.env.NAMECHEAP_API_KEY;
      delete process.env.NAMECHEAP_API_USER;
    }
  });

  it("Vercel project creation names VERCEL_TOKEN", async () => {
    delete process.env.VERCEL_TOKEN;
    const store = freshStore();
    seedAcme(store);

    const res = await pa.vercelCreateProject(store, { environment: "staging", name: "acme-site" });

    expect(res.status).toBe("error");
    expect((res as any).error).toMatch(/VERCEL_TOKEN/);
  });

  it("Stripe webhook creation names STRIPE_TEST_SECRET_KEY", async () => {
    delete process.env.STRIPE_TEST_SECRET_KEY;
    const store = freshStore();
    seedAcme(store);

    const res = await pa.stripeCreateWebhook(store, {
      environment: "staging",
      url: "https://example.com/api/stripe/webhook",
      enabledEvents: ["invoice.paid"],
    });

    expect(res.status).toBe("error");
    expect((res as any).error).toMatch(/STRIPE_TEST_SECRET_KEY/);
  });
});

describe("Stripe price validation", () => {
  it("lists Stripe customers through the guarded read path", async () => {
    const store = freshStore();
    seedAcme(store);
    fetchMock.mockResolvedValueOnce(mockOk({ data: [{ id: "cus_123", email: "a@example.com", name: "Ada", created: 1 }] }));

    const res = await pa.stripeListCustomers(store, { environment: "staging", limit: 1 });

    expect(res.status).toBe("ok");
    expect((res as any).data[0]).toMatchObject({ id: "cus_123", email: "a@example.com" });
    expect(lastAudit(store)).toMatchObject({ result: "success", provider: "stripe", tool: "list_stripe_customers" });
  });

  it("rejects empty product names before calling Stripe", async () => {
    const store = freshStore();
    seedAcme(store);
    const res = await pa.stripeCreateProduct(store, {
      environment: "staging",
      name: "   ",
    });
    expect(res.status).toBe("error");
    expect((res as any).error).toMatch(/name/i);
    expect(providerCalls()).toHaveLength(0);
  });

  it("rejects non-positive price amounts before calling Stripe", async () => {
    const store = freshStore();
    seedAcme(store);
    const res = await pa.stripeCreatePrice(store, {
      environment: "staging",
      product: "prod_123",
      currency: "usd",
      unitAmount: 0,
    });
    expect(res.status).toBe("error");
    expect((res as any).error).toMatch(/unitAmount/i);
    expect(providerCalls()).toHaveLength(0);
  });
});
