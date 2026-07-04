import { randomUUID } from "node:crypto";
import type { Context, Next } from "hono";
import { Redis } from "ioredis";

export type RateRule = { limit: number; windowMs: number };

// Per-route limits, keyed by client IP.
export const RATE_LIMITS = {
  authStrict: { limit: 8, windowMs: 15 * 60_000 }, // login / forgot / reset — anti brute-force
  authSignup: { limit: 10, windowMs: 60 * 60_000 }, // register
  resend: { limit: 4, windowMs: 15 * 60_000 }, // resend verification email
  inquiry: { limit: 6, windowMs: 10 * 60_000 }, // inquiry creation — anti-spam
  review: { limit: 10, windowMs: 60 * 60_000 }, // review submission
  message: { limit: 30, windowMs: 10 * 60_000 }, // thread messages - conversational
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

// ---------------------------------------------------------------------------
// Distributed backend (#117): when REDIS_URL is set the window lives in Redis
// (shared across gateway instances/restarts); otherwise the in-memory store
// above applies. Redis failures FALL BACK to the in-memory check — degraded
// per-instance limiting beats returning errors or no limiting at all.
// ---------------------------------------------------------------------------

// Minimal command surface so tests can inject a fake.
export type RedisCommands = {
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zcard(key: string): Promise<number>;
  zrem(key: string, member: string): Promise<number>;
  zrange(key: string, start: number, stop: number, withScores: "WITHSCORES"): Promise<string[]>;
  pexpire(key: string, ms: number): Promise<number>;
};

// Sliding window over a sorted set: drop expired hits, optimistically add
// this one, then count. Over the limit → remove our member again and report
// when the oldest hit leaves the window. The add-then-count order keeps
// concurrent requests from double-spending the last slot.
export async function checkRateLimitRedis(
  redis: RedisCommands,
  key: string,
  rule: RateRule,
  now = Date.now()
) {
  const windowStart = now - rule.windowMs;
  const member = `${now}:${randomUUID()}`;
  await redis.zremrangebyscore(key, 0, windowStart);
  await redis.zadd(key, now, member);
  const count = await redis.zcard(key);
  await redis.pexpire(key, rule.windowMs);

  if (count <= rule.limit) {
    return { success: true, remaining: rule.limit - count, retryAfterMs: 0 };
  }

  await redis.zrem(key, member);
  const oldest = await redis.zrange(key, 0, 0, "WITHSCORES");
  const oldestScore = oldest.length >= 2 ? Number(oldest[1]) : now;
  return {
    success: false,
    remaining: 0,
    retryAfterMs: Math.max(0, oldestScore + rule.windowMs - now),
  };
}

// undefined = not initialized yet; null = no REDIS_URL configured.
let redisClient: RedisCommands | null | undefined;

function getRedis(): RedisCommands | null {
  if (redisClient !== undefined) return redisClient;
  const url = process.env.REDIS_URL;
  if (!url) {
    redisClient = null;
    return null;
  }
  // Fail fast while disconnected (no offline queue) so a Redis outage drops
  // straight into the in-memory fallback instead of stalling requests.
  redisClient = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  return redisClient;
}

// Returns a 429 response when the caller is over the limit, otherwise null.
export async function rateLimit(
  c: Context,
  name: string,
  rule: RateRule
): Promise<Response | null> {
  const key = `${name}:${clientIp(c)}`;
  const redis = getRedis();
  let result: { success: boolean; retryAfterMs: number };
  if (redis) {
    try {
      result = await checkRateLimitRedis(redis, `rl:${key}`, rule);
    } catch {
      result = checkRateLimit(key, rule);
    }
  } else {
    result = checkRateLimit(key, rule);
  }
  if (result.success) return null;
  const retryAfter = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
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
  // change-password and delete-account verify the current password, so each
  // is a guessing oracle for anyone holding a hijacked session — same budget
  // as login.
  { pattern: /^\/api\/auth\/change-password$/, name: "auth-change", rule: RATE_LIMITS.authStrict },
  { pattern: /^\/api\/auth\/delete-account$/, name: "auth-delete", rule: RATE_LIMITS.authStrict },
  { pattern: /^\/api\/auth\/register$/, name: "auth-register", rule: RATE_LIMITS.authSignup },
  { pattern: /^\/api\/auth\/resend-verification$/, name: "auth-resend", rule: RATE_LIMITS.resend },
  { pattern: /^\/api\/jobs$/, name: "job-post", rule: RATE_LIMITS.inquiry },
  { pattern: /^\/api\/providers\/[^/]+\/inquiries$/, name: "inquiry", rule: RATE_LIMITS.inquiry },
  { pattern: /^\/api\/jobs\/[^/]+\/responses$/, name: "job-response", rule: RATE_LIMITS.review },
  { pattern: /^\/api\/providers\/[^/]+\/reviews$/, name: "review", rule: RATE_LIMITS.review },
  // Thread messages (#13) are conversational - wider budget than one-shot forms.
  { pattern: /^\/api\/inquiries\/[^/]+\/messages$/, name: "message", rule: RATE_LIMITS.message },
  // Abuse reports (#50) accept anonymous submissions, so the IP budget is the
  // main spam control. One shared "report" bucket across the three target
  // types, on the review budget.
  { pattern: /^\/api\/providers\/[^/]+\/report$/, name: "report", rule: RATE_LIMITS.review },
  { pattern: /^\/api\/photos\/[^/]+\/report$/, name: "report", rule: RATE_LIMITS.review },
  { pattern: /^\/api\/reviews\/[^/]+\/report$/, name: "report", rule: RATE_LIMITS.review },
];

export async function rateLimitMiddleware(c: Context, next: Next) {
  if (c.req.method === "POST") {
    const pathname = new URL(c.req.url).pathname;
    for (const route of LIMITED_ROUTES) {
      if (route.pattern.test(pathname)) {
        const limited = await rateLimit(c, route.name, route.rule);
        if (limited) return limited;
        break;
      }
    }
  }
  await next();
}
