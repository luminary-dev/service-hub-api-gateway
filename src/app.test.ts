import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SignJWT } from "jose";
import { app } from "./app";
import { clearSessionVersionCache } from "./lib/session-version";

// Sign with the same secret session.ts resolved at import time: AUTH_SECRET
// when the environment provides one (CI does), else the shared dev fallback.
const DEV_SECRET = new TextEncoder().encode(
  process.env.AUTH_SECRET ?? "dev-only-secret"
);

async function signSession(payload: Record<string, unknown>) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(DEV_SECRET);
}

// Stub the global fetch the proxy uses to reach upstream services, capturing
// the forwarded Request so tests can assert on it.
let upstreamRequests: Request[];
let upstreamResponse: () => Response | Promise<Response>;

beforeEach(() => {
  upstreamRequests = [];
  upstreamResponse = () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: Request | string | URL) => {
      const req = input instanceof Request ? input : new Request(input);
      upstreamRequests.push(req);
      return upstreamResponse();
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /healthz", () => {
  it("responds without auth and without proxying", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "api-gateway" });
    expect(upstreamRequests).toHaveLength(0);
  });
});

describe("CSRF", () => {
  it("blocks cross-site state-changing requests", async () => {
    const res = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Cross-site request blocked." });
    expect(upstreamRequests).toHaveLength(0);
  });

  it("allows same-origin POSTs through", async () => {
    const res = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(res.status).toBe(200);
    expect(upstreamRequests).toHaveLength(1);
  });

  it("compares Origin against x-forwarded-host when Sec-Fetch-Site is absent", async () => {
    const res = await app.request("/api/auth/logout", {
      method: "POST",
      headers: { origin: "https://evil.example", "x-forwarded-host": "baas.lk" },
    });
    expect(res.status).toBe(403);
  });

  it("never blocks GETs", async () => {
    const res = await app.request("/api/providers", {
      headers: { "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(200);
  });
});

describe("rate limiting", () => {
  it("returns the monolith 429 body and Retry-After once over the limit", async () => {
    const headers = {
      "sec-fetch-site": "same-origin",
      "x-forwarded-for": "203.0.113.77",
    };
    // authStrict allows 8 login attempts per window.
    for (let i = 0; i < 8; i++) {
      const res = await app.request("/api/auth/login", { method: "POST", headers });
      expect(res.status).toBe(200);
    }
    const blocked = await app.request("/api/auth/login", { method: "POST", headers });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await blocked.json()).toEqual({
      error: "Too many requests. Please slow down and try again shortly.",
    });
  });

  it("keys by client IP so other clients are unaffected", async () => {
    const mk = (ip: string) =>
      app.request("/api/auth/resend-verification", {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin", "x-forwarded-for": ip },
      });
    for (let i = 0; i < 4; i++) expect((await mk("198.51.100.1")).status).toBe(200);
    expect((await mk("198.51.100.1")).status).toBe(429);
    expect((await mk("198.51.100.2")).status).toBe(200);
  });

  it.each([
    ["/api/auth/change-password", "203.0.113.88"],
    ["/api/auth/delete-account", "203.0.113.89"],
  ])("rate-limits %s with the strict auth budget", async (path, ip) => {
    const headers = { "sec-fetch-site": "same-origin", "x-forwarded-for": ip };
    for (let i = 0; i < 8; i++) {
      const res = await app.request(path, { method: "POST", headers });
      expect(res.status).toBe(200);
    }
    const blocked = await app.request(path, { method: "POST", headers });
    expect(blocked.status).toBe(429);
  });

  it.each([
    ["/api/providers/prov-1/report", "203.0.113.91"],
    ["/api/photos/ph-1/report", "203.0.113.92"],
    ["/api/reviews/rev-1/report", "203.0.113.93"],
  ])("rate-limits %s with the report (review) budget", async (path, ip) => {
    const headers = { "sec-fetch-site": "same-origin", "x-forwarded-for": ip };
    // The review budget allows 10 submissions per window.
    for (let i = 0; i < 10; i++) {
      const res = await app.request(path, { method: "POST", headers });
      expect(res.status).toBe(200);
    }
    const blocked = await app.request(path, { method: "POST", headers });
    expect(blocked.status).toBe(429);
  });

  it("rate-limits thread messages with the conversational budget", async () => {
    const headers = { "sec-fetch-site": "same-origin", "x-forwarded-for": "203.0.113.90" };
    // message budget: 30 per 10 minutes.
    for (let i = 0; i < 30; i++) {
      const res = await app.request("/api/inquiries/inq-1/messages", { method: "POST", headers });
      expect(res.status).toBe(200);
    }
    const blocked = await app.request("/api/inquiries/inq-1/messages", { method: "POST", headers });
    expect(blocked.status).toBe(429);
  });

  it("does not rate-limit unlisted routes", async () => {
    for (let i = 0; i < 15; i++) {
      const res = await app.request("/api/auth/logout", {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin", "x-forwarded-for": "198.51.100.9" },
      });
      expect(res.status).toBe(200);
    }
  });
});

describe("identity headers", () => {
  it("strips client-sent x-user-id / x-internal-secret and sets gateway values", async () => {
    const res = await app.request("/api/providers", {
      headers: {
        "x-user-id": "spoofed-user",
        "x-user-role": "ADMIN",
        "x-user-name": "spoof",
        "x-internal-secret": "wrong",
        "x-locale": "si",
        "x-origin": "https://evil.example",
      },
    });
    expect(res.status).toBe(200);
    expect(upstreamRequests).toHaveLength(1);
    const fwd = upstreamRequests[0].headers;
    expect(fwd.get("x-user-id")).toBeNull();
    expect(fwd.get("x-user-role")).toBeNull();
    expect(fwd.get("x-user-name")).toBeNull();
    expect(fwd.get("x-internal-secret")).toBe("dev-internal-secret");
    expect(fwd.get("x-locale")).toBe("en");
    expect(fwd.get("x-origin")).toBe("http://localhost:3000");
  });

  it("forwards identity headers for a valid sh_session cookie", async () => {
    const token = await signSession({ userId: "user-1", role: "CUSTOMER", name: "Ann Silva" });
    const res = await app.request("/api/auth/me", {
      headers: { cookie: `sh_session=${token}` },
    });
    expect(res.status).toBe(200);
    // With a session present the first upstream call is the session-version
    // lookup; the proxied request is the last one.
    const fwd = upstreamRequests.at(-1)!.headers;
    expect(fwd.get("x-user-id")).toBe("user-1");
    expect(fwd.get("x-user-role")).toBe("CUSTOMER");
    expect(fwd.get("x-user-name")).toBe(encodeURIComponent("Ann Silva"));
    expect(fwd.get("x-internal-secret")).toBe("dev-internal-secret");
  });

  it("omits identity headers (without erroring) on an invalid session", async () => {
    const res = await app.request("/api/auth/me", {
      headers: { cookie: "sh_session=not-a-jwt" },
    });
    expect(res.status).toBe(200);
    const fwd = upstreamRequests[0].headers;
    expect(fwd.get("x-user-id")).toBeNull();
    expect(fwd.get("x-user-role")).toBeNull();
    expect(fwd.get("x-user-name")).toBeNull();
  });

  it("derives x-locale from the lang cookie and x-origin from forwarded headers", async () => {
    await app.request("/api/providers", {
      headers: {
        cookie: "lang=si",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "baas.lk",
      },
    });
    const fwd = upstreamRequests[0].headers;
    expect(fwd.get("x-locale")).toBe("si");
    expect(fwd.get("x-origin")).toBe("https://baas.lk");
  });
});

describe("request id", () => {
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it("sets a generated x-request-id on upstream requests", async () => {
    const res = await app.request("/api/providers");
    expect(res.status).toBe(200);
    expect(upstreamRequests[0].headers.get("x-request-id")).toMatch(UUID_RE);
  });

  it("strips a client-sent x-request-id and uses its own (no spoofing)", async () => {
    await app.request("/api/providers", {
      headers: { "x-request-id": "spoofed-id" },
    });
    const forwarded = upstreamRequests[0].headers.get("x-request-id");
    expect(forwarded).not.toBe("spoofed-id");
    expect(forwarded).toMatch(UUID_RE);
  });
});

describe("session revocation", () => {
  beforeEach(() => {
    clearSessionVersionCache();
  });

  const versionResponse = (v: number | null) => () =>
    new Response(JSON.stringify({ v }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  it("omits identity headers when the token was minted before the current version", async () => {
    const token = await signSession({ userId: "rev-1", role: "CUSTOMER", name: "R", sv: 1 });
    upstreamResponse = versionResponse(2);
    const res = await app.request("/api/auth/me", {
      headers: { cookie: `sh_session=${token}` },
    });
    expect(res.status).toBe(200);
    expect(upstreamRequests[0].url).toContain("/internal/users/rev-1/session-version");
    const fwd = upstreamRequests.at(-1)!.headers;
    expect(fwd.get("x-user-id")).toBeNull();
  });

  it("forwards identity headers when the token version is current", async () => {
    const token = await signSession({ userId: "rev-2", role: "CUSTOMER", name: "R", sv: 2 });
    upstreamResponse = versionResponse(2);
    await app.request("/api/auth/me", { headers: { cookie: `sh_session=${token}` } });
    expect(upstreamRequests.at(-1)!.headers.get("x-user-id")).toBe("rev-2");
  });

  it("treats a token newer than the cached version as proof the cache is stale", async () => {
    // Prime the cache at v=2, then present a v=3 token (fresh cookie right
    // after change-password) — it must be accepted without another lookup.
    const oldToken = await signSession({ userId: "rev-3", role: "CUSTOMER", name: "R", sv: 2 });
    upstreamResponse = versionResponse(2);
    await app.request("/api/auth/me", { headers: { cookie: `sh_session=${oldToken}` } });
    const lookups = upstreamRequests.filter((r) => r.url.includes("session-version")).length;

    const newToken = await signSession({ userId: "rev-3", role: "CUSTOMER", name: "R", sv: 3 });
    await app.request("/api/auth/me", { headers: { cookie: `sh_session=${newToken}` } });
    expect(upstreamRequests.at(-1)!.headers.get("x-user-id")).toBe("rev-3");
    expect(
      upstreamRequests.filter((r) => r.url.includes("session-version")).length
    ).toBe(lookups);
  });

  it("rejects tokens for users that no longer exist", async () => {
    const token = await signSession({ userId: "rev-4", role: "CUSTOMER", name: "R", sv: 0 });
    upstreamResponse = versionResponse(null);
    await app.request("/api/auth/me", { headers: { cookie: `sh_session=${token}` } });
    expect(upstreamRequests.at(-1)!.headers.get("x-user-id")).toBeNull();
  });

  it("fails open when identity-service is unreachable", async () => {
    const token = await signSession({ userId: "rev-5", role: "CUSTOMER", name: "R", sv: 1 });
    upstreamResponse = () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    };
    // The proxied request itself also fails (502) — what matters is that the
    // identity headers were still attached to the attempt.
    const res = await app.request("/api/auth/me", {
      headers: { cookie: `sh_session=${token}` },
    });
    expect(res.status).toBe(502);
    expect(upstreamRequests.at(-1)!.headers.get("x-user-id")).toBe("rev-5");
  });

  it("treats legacy tokens without sv as version 0", async () => {
    const token = await signSession({ userId: "rev-6", role: "CUSTOMER", name: "R" });
    upstreamResponse = versionResponse(0);
    await app.request("/api/auth/me", { headers: { cookie: `sh_session=${token}` } });
    expect(upstreamRequests.at(-1)!.headers.get("x-user-id")).toBe("rev-6");

    clearSessionVersionCache();
    upstreamResponse = versionResponse(1);
    await app.request("/api/auth/me", { headers: { cookie: `sh_session=${token}` } });
    expect(upstreamRequests.at(-1)!.headers.get("x-user-id")).toBeNull();
  });
});

describe("proxying", () => {
  it("forwards to the mapped upstream preserving path and query", async () => {
    process.env.PROVIDER_SERVICE_URL = "http://provider.test:4002";
    try {
      await app.request("/api/providers?q=plumber&page=2");
      expect(upstreamRequests[0].url).toBe(
        "http://provider.test:4002/api/providers?q=plumber&page=2"
      );
    } finally {
      delete process.env.PROVIDER_SERVICE_URL;
    }
  });

  it("rewrites /api/files/* to the upstream /files/*", async () => {
    await app.request("/api/files/provider/avatars/a.jpg");
    expect(upstreamRequests[0].url).toBe("http://localhost:4002/files/avatars/a.jpg");
    await app.request("/api/files/review/reviews/r.png");
    expect(upstreamRequests[1].url).toBe("http://localhost:4003/files/reviews/r.png");
  });

  it("routes provider reviews to review-service", async () => {
    await app.request("/api/providers/prov-1/reviews", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin", "x-forwarded-for": "198.51.100.50" },
    });
    expect(upstreamRequests[0].url).toBe("http://localhost:4003/api/providers/prov-1/reviews");
  });

  it("streams the request body through unmodified", async () => {
    const body = JSON.stringify({ title: "Fix sink" });
    await app.request("/api/jobs", {
      method: "POST",
      headers: {
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        "x-forwarded-for": "198.51.100.60",
      },
      body,
    });
    expect(upstreamRequests[0].method).toBe("POST");
    expect(await upstreamRequests[0].text()).toBe(body);
  });

  it("passes upstream status and Set-Cookie back verbatim", async () => {
    upstreamResponse = () =>
      new Response(JSON.stringify({ error: "Invalid email or password" }), {
        status: 401,
        headers: {
          "content-type": "application/json",
          "set-cookie": "sh_session=abc; Path=/; HttpOnly",
        },
      });
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin", "x-forwarded-for": "198.51.100.70" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBe("sh_session=abc; Path=/; HttpOnly");
    expect(await res.json()).toEqual({ error: "Invalid email or password" });
  });

  it("404s unknown paths and never forwards /internal", async () => {
    for (const path of ["/api/unknown", "/api/jobs/internal/jobs/count", "/nope"]) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not found" });
    }
    expect(upstreamRequests).toHaveLength(0);
  });

  it("502s when the upstream is unreachable", async () => {
    upstreamResponse = () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    };
    const res = await app.request("/api/providers");
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Upstream service unavailable" });
  });
});
