import type { Context, Next } from "hono";

export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Decides whether a request may perform a state change. Safe methods always
// pass. For unsafe methods we trust the browser-set Sec-Fetch-Site header
// (which a cross-site attacker page cannot forge); when it's absent (non-browser
// clients, which carry no ambient cookies to abuse) we fall back to comparing
// the Origin host with the request host.
export function isSameOriginRequest(req: {
  method: string;
  secFetchSite: string | null;
  origin: string | null;
  host: string | null;
}): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return true;

  if (req.secFetchSite) {
    return req.secFetchSite === "same-origin" || req.secFetchSite === "none";
  }

  // No Sec-Fetch-Site: not a browser cross-site request. Verify Origin if present.
  if (!req.origin) return true;
  try {
    return new URL(req.origin).host === req.host;
  } catch {
    return false;
  }
}

// CSRF defence-in-depth on top of SameSite=Lax cookies: reject cross-site
// state-changing requests to the API (replaces the monolith's middleware.ts).
// The gateway sits behind the web app's rewrite, so the public host arrives in
// x-forwarded-host; fall back to the direct Host header.
export async function csrfMiddleware(c: Context, next: Next) {
  const allowed = isSameOriginRequest({
    method: c.req.method,
    secFetchSite: c.req.header("sec-fetch-site") ?? null,
    origin: c.req.header("origin") ?? null,
    host: c.req.header("x-forwarded-host") ?? c.req.header("host") ?? null,
  });
  if (!allowed) {
    return c.json({ error: "Cross-site request blocked." }, 403);
  }
  await next();
}
