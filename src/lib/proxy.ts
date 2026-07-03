import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { proxy } from "hono/proxy";
import { resolveRoute, serviceUrl } from "./routes";
import { SESSION_COOKIE, verifySessionToken } from "./session";

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
];

// Public web origin, forwarded so services can build absolute links (emails).
function resolveOrigin(c: Context): string {
  const proto = c.req.header("x-forwarded-proto");
  const forwardedHost = c.req.header("x-forwarded-host");
  if (!proto && !forwardedHost) {
    return process.env.WEB_ORIGIN ?? "http://localhost:3000";
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

  // Verified session → identity headers. Invalid/absent → forwarded without
  // them (services decide 401s); never an error here.
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const session = await verifySessionToken(token);
    if (session) {
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
    return await proxy(target, { method, headers, body });
  } catch (err) {
    console.error(`upstream ${route.service} failed:`, err);
    return c.json({ error: "Upstream service unavailable" }, 502);
  }
}
