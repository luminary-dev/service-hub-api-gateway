import { describe, it, expect } from "vitest";
import { checkRateLimit } from "./rate-limit";

const rule = { limit: 3, windowMs: 1000 };

describe("checkRateLimit (sliding window)", () => {
  it("allows up to the limit then blocks", () => {
    const key = "test:allow-then-block";
    const now = 1_000_000;
    expect(checkRateLimit(key, rule, now).success).toBe(true);
    expect(checkRateLimit(key, rule, now).success).toBe(true);
    expect(checkRateLimit(key, rule, now).success).toBe(true);
    const blocked = checkRateLimit(key, rule, now);
    expect(blocked.success).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("reports decreasing remaining count", () => {
    const key = "test:remaining";
    const now = 2_000_000;
    expect(checkRateLimit(key, rule, now).remaining).toBe(2);
    expect(checkRateLimit(key, rule, now).remaining).toBe(1);
    expect(checkRateLimit(key, rule, now).remaining).toBe(0);
  });

  it("recovers after the window slides past old hits", () => {
    const key = "test:recover";
    const now = 3_000_000;
    checkRateLimit(key, rule, now);
    checkRateLimit(key, rule, now);
    checkRateLimit(key, rule, now);
    expect(checkRateLimit(key, rule, now).success).toBe(false);
    // Advance beyond the window — the old hits expire.
    expect(checkRateLimit(key, rule, now + rule.windowMs + 1).success).toBe(true);
  });

  it("keys are isolated from each other", () => {
    const now = 4_000_000;
    checkRateLimit("test:a", rule, now);
    checkRateLimit("test:a", rule, now);
    checkRateLimit("test:a", rule, now);
    expect(checkRateLimit("test:a", rule, now).success).toBe(false);
    expect(checkRateLimit("test:b", rule, now).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Redis-backed window, exercised against a minimal in-process fake that
// implements real sorted-set semantics for the commands we use.
// ---------------------------------------------------------------------------
import { checkRateLimitRedis, type RedisCommands } from "./rate-limit";

function fakeRedis(): RedisCommands & { sets: Map<string, Map<string, number>> } {
  const sets = new Map<string, Map<string, number>>();
  const setFor = (key: string) => {
    if (!sets.has(key)) sets.set(key, new Map());
    return sets.get(key)!;
  };
  return {
    sets,
    async zremrangebyscore(key, _min, max) {
      const s = setFor(key);
      let removed = 0;
      for (const [member, score] of s) {
        if (score <= Number(max)) {
          s.delete(member);
          removed++;
        }
      }
      return removed;
    },
    async zadd(key, score, member) {
      setFor(key).set(member, score);
      return 1;
    },
    async zcard(key) {
      return setFor(key).size;
    },
    async zrem(key, member) {
      return setFor(key).delete(member) ? 1 : 0;
    },
    async zrange(key, start, stop, _withScores) {
      const sorted = [...setFor(key)].sort((a, b) => a[1] - b[1]);
      return sorted.slice(start, stop + 1).flatMap(([m, s]) => [m, String(s)]);
    },
    async pexpire() {
      return 1;
    },
  };
}

describe("checkRateLimitRedis", () => {
  const rule = { limit: 3, windowMs: 60_000 };

  it("allows up to the limit and then blocks", async () => {
    const redis = fakeRedis();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) {
      const r = await checkRateLimitRedis(redis, "rl:test", rule, t0 + i);
      expect(r.success).toBe(true);
    }
    const blocked = await checkRateLimitRedis(redis, "rl:test", rule, t0 + 10);
    expect(blocked.success).toBe(false);
    expect(blocked.retryAfterMs).toBeGreaterThan(0);
  });

  it("does not leave a hit behind for blocked requests", async () => {
    const redis = fakeRedis();
    const t0 = 1_000_000;
    for (let i = 0; i < 4; i++) await checkRateLimitRedis(redis, "rl:x", rule, t0 + i);
    // 3 allowed hits remain; the blocked one removed itself.
    expect(redis.sets.get("rl:x")!.size).toBe(3);
  });

  it("frees slots once old hits leave the window", async () => {
    const redis = fakeRedis();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) await checkRateLimitRedis(redis, "rl:y", rule, t0 + i);
    expect((await checkRateLimitRedis(redis, "rl:y", rule, t0 + 100)).success).toBe(false);
    const later = await checkRateLimitRedis(redis, "rl:y", rule, t0 + rule.windowMs + 5);
    expect(later.success).toBe(true);
  });

  it("reports retry-after based on the oldest hit in the window", async () => {
    const redis = fakeRedis();
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) await checkRateLimitRedis(redis, "rl:z", rule, t0 + i * 1000);
    const blocked = await checkRateLimitRedis(redis, "rl:z", rule, t0 + 5000);
    // Oldest hit at t0 leaves the window at t0 + 60000 → 55000ms from t0+5000.
    expect(blocked.retryAfterMs).toBe(55_000);
  });
});
