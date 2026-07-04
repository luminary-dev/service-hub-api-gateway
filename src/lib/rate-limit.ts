import type { Context, Next } from "hono";

export type RateRule = { limit: number; windowMs: number };

// Per-route limits, keyed by client IP.
export const RATE_LIMITS = {
  authStrict: { limit: 8, windowMs: 15 * 60_000 }, // login / forgot / reset — anti brute-force
  authSignup: { limit: 10, windowMs: 60 * 60_000 }, // register
  resend: { limit: 4, windowMs: 15 * 60_000 }, // resend verification email
  inquiry: { limit: 6, windowMs: 10 * 60_000 }, // inquiry creation — anti-spam
  review: { limit: 10, windowMs: 60 * 60_000 }, // review submission
} as const;

// In-memory sliding-window store. This state is per-instance and resets on
// restart, so it is best-effort — enough to blunt naive brute-force and spam
// bursts. For strict, cross-instance limits back this with a shared store
// (the checkRateLimit interface is drop-in).
const hits = new Map<string, number[]>();
const MAX_RETENTION_MS = 60 * 60_000;
let lastSweep = 0;

function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, times] of hits) {
    if (times.length === 0 || times[times.length - 1] < now - MAX_RETENTION_MS) {
      hits.delete(key);
    }
  }
}

export function checkRateLimit(key: string, rule: RateRule, now = Date.now()) {
  sweep(now);
  const windowStart = now - rule.windowMs;
  const recent = (hits.get(key) ?? []).filter((t) => t > windowStart);
  const success = recent.length < rule.limit;
  if (success) recent.push(now);
  hits.set(key, recent);
  const retryAfterMs = success ? 0 : recent[0] + rule.windowMs - now;
  return {
    success,
    remaining: Math.max(0, rule.limit - recent.length),
    retryAfterMs,
  };
}

export function clientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return c.req.header("x-real-ip") ?? "unknown";
}

// Returns a 429 response when the caller is over the limit, otherwise null.
export function rateLimit(c: Context, name: string, rule: RateRule): Response | null {
  const { success, retryAfterMs } = checkRateLimit(`${name}:${clientIp(c)}`, rule);
  if (success) return null;
  const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return c.json(
    { error: "Too many requests. Please slow down and try again shortly." },
    429,
    { "Retry-After": String(retryAfter) }
  );
}

// The contract's rate-limit table. Rule names match the monolith's
// rateLimit(req, name, rule) calls exactly so keys stay identical.
const LIMITED_ROUTES: { pattern: RegExp; name: string; rule: RateRule }[] = [
  { pattern: /^\/api\/auth\/login$/, name: "auth-login", rule: RATE_LIMITS.authStrict },
  { pattern: /^\/api\/auth\/forgot-password$/, name: "auth-forgot", rule: RATE_LIMITS.authStrict },
  { pattern: /^\/api\/auth\/reset-password$/, name: "auth-reset", rule: RATE_LIMITS.authStrict },
  // change-password verifies the current password, so it's a guessing oracle
  // for anyone holding a hijacked session — same budget as login.
  { pattern: /^\/api\/auth\/change-password$/, name: "auth-change", rule: RATE_LIMITS.authStrict },
  { pattern: /^\/api\/auth\/register$/, name: "auth-register", rule: RATE_LIMITS.authSignup },
  { pattern: /^\/api\/auth\/resend-verification$/, name: "auth-resend", rule: RATE_LIMITS.resend },
  { pattern: /^\/api\/jobs$/, name: "job-post", rule: RATE_LIMITS.inquiry },
  { pattern: /^\/api\/providers\/[^/]+\/inquiries$/, name: "inquiry", rule: RATE_LIMITS.inquiry },
  { pattern: /^\/api\/jobs\/[^/]+\/responses$/, name: "job-response", rule: RATE_LIMITS.review },
  { pattern: /^\/api\/providers\/[^/]+\/reviews$/, name: "review", rule: RATE_LIMITS.review },
];

export async function rateLimitMiddleware(c: Context, next: Next) {
  if (c.req.method === "POST") {
    const pathname = new URL(c.req.url).pathname;
    for (const route of LIMITED_ROUTES) {
      if (route.pattern.test(pathname)) {
        const limited = rateLimit(c, route.name, route.rule);
        if (limited) return limited;
        break;
      }
    }
  }
  await next();
}
