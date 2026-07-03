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
