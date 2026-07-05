import { randomUUID } from "node:crypto";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { proxy } from "hono/proxy";
import { log } from "./log";
import { getRequestId } from "./logging";
import { resolveRoute, serviceUrl } from "./routes";
import { SESSION_COOKIE, verifySessionToken } from "./session";
import { sessionVersionOk } from "./session-version";

// The gateway stamps this secret on every upstream request; if it silently fell
// back to the public dev constant in production, anyone able to reach a service
// directly could forge gateway-trusted identity headers. Fail fast (mirrors the
// AUTH_SECRET guard in session.ts).
if (!process.env.INTERNAL_API_SECRET && process.env.NODE_ENV === "production") {
  throw new Error("INTERNAL_API_SECRET must be set in production");
}

// Upper bound on how long the gateway waits for an upstream. Without it a
// single hung service pins gateway connections indefinitely and can take down
// every route. No long-lived streams pass through the gateway (chat SSE is
// web→chat-service direct; media serves bounded files), so a flat deadline is
// safe.
const UPSTREAM_TIMEOUT_MS = 30_000;

// Hop-by-hop headers never forwarded upstream (host is re-set to the upstream).
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "host",
];

// Trusted headers the gateway owns — anything the client sent is stripped
// before the gateway sets its own values.
const GATEWAY_HEADERS = [
  "x-user-id",
  "x-user-role",
  "x-user-name",
  "x-internal-secret",
  "x-locale",
  "x-origin",
  "x-request-id",
];

// Public web origin, forwarded so services can build absolute links (emails).
// A configured WEB_ORIGIN is authoritative and wins over any client-supplied
// forwarding headers — otherwise a spoofed x-forwarded-host could poison the
// links in password-reset / verification emails (account-takeover vector). The
// header fallback only applies in dev, when WEB_ORIGIN is unset.
function resolveOrigin(c: Context): string {
  if (process.env.WEB_ORIGIN) return process.env.WEB_ORIGIN;
  const proto = c.req.header("x-forwarded-proto");
  const forwardedHost = c.req.header("x-forwarded-host");
  if (!proto && !forwardedHost) {
    return "http://localhost:3000";
  }
  const host = forwardedHost ?? c.req.header("host");
  return `${proto ?? "http"}://${host}`;
}

export async function buildUpstreamHeaders(
  c: Context,
  upstreamHost: string
): Promise<Headers> {
  const headers = new Headers(c.req.raw.headers);
  for (const name of HOP_BY_HOP) headers.delete(name);
  for (const name of GATEWAY_HEADERS) headers.delete(name);
  headers.set("host", upstreamHost);

  // Verified session → identity headers. Invalid/absent/revoked → forwarded
  // without them (services decide 401s); never an error here. Revocation:
  // the token's sv must still match the user's current sessionVersion.
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const session = await verifySessionToken(token);
    if (session && (await sessionVersionOk(session.userId, session.sv))) {
      headers.set("x-user-id", session.userId);
      headers.set("x-user-role", session.role);
      headers.set("x-user-name", encodeURIComponent(session.name));
    }
  }

  headers.set(
    "x-internal-secret",
    process.env.INTERNAL_API_SECRET ?? "dev-internal-secret"
  );
  headers.set("x-locale", getCookie(c, "lang") === "si" ? "si" : "en");
  headers.set("x-origin", resolveOrigin(c));
  // The gateway-generated request id (see app.ts requestLogger) follows the
  // request across services — client-sent values were stripped above.
  headers.set("x-request-id", getRequestId(c) ?? randomUUID());

  return headers;
}

// Reverse proxy: original method/path/query/body pass through unmodified
// (including multipart); the upstream response — status and headers,
// Set-Cookie included — passes back verbatim.
//
// Request bodies are buffered rather than streamed: a one-shot inbound stream
// cannot be replayed when undici resends on a reused connection ("expected
// non-null body source"), and payloads are capped small (5MB uploads).
export async function proxyRequest(c: Context) {
  const url = new URL(c.req.url);
  const route = resolveRoute(url.pathname);
  if (!route) return c.json({ error: "Not found" }, 404);

  const base = serviceUrl(route.service);
  const target = `${base}${route.path}${url.search}`;
  const headers = await buildUpstreamHeaders(c, new URL(base).host);

  const method = c.req.method;
  const body =
    method === "GET" || method === "HEAD"
      ? undefined
      : await c.req.raw.arrayBuffer();

  try {
    return await proxy(target, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "TimeoutError";
    log.error("upstream request failed", {
      upstream: route.service,
      requestId: getRequestId(c),
      timedOut,
      err,
    });
    return c.json(
      { error: "Upstream service unavailable" },
      timedOut ? 504 : 502
    );
  }
}
