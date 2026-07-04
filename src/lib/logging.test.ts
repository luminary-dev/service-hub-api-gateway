// Unit tests for the canonical structured logger — identical copy in every
// service (same rationale as categories.test.ts). The write fn is injected so
// nothing here parses stdout.
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createLogger, getRequestId, requestLogger } from "./logging";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function capture() {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

describe("createLogger", () => {
  it("emits one JSON line with level/time/service/msg plus fields", () => {
    const { lines, write } = capture();
    const log = createLogger("test-service", write);
    log.info("hello", { a: 1, b: "two" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    const entry = JSON.parse(lines[0]);
    expect(entry).toMatchObject({
      level: "info",
      service: "test-service",
      msg: "hello",
      a: 1,
      b: "two",
    });
    // time is a valid ISO-8601 timestamp.
    expect(new Date(entry.time).toISOString()).toBe(entry.time);
  });

  it("emits warn and error levels", () => {
    const { lines, write } = capture();
    const log = createLogger("test-service", write);
    log.warn("careful");
    log.error("broken");
    expect(JSON.parse(lines[0]).level).toBe("warn");
    expect(JSON.parse(lines[1]).level).toBe("error");
  });

  it("serializes Error fields into name/message/stack", () => {
    const { lines, write } = capture();
    const log = createLogger("test-service", write);
    log.error("upstream call failed", { err: new Error("kaboom") });
    const entry = JSON.parse(lines[0]);
    expect(entry.err.name).toBe("Error");
    expect(entry.err.message).toBe("kaboom");
    expect(typeof entry.err.stack).toBe("string");
  });

  it("still emits a line when fields are unserializable", () => {
    const { lines, write } = capture();
    const log = createLogger("test-service", write);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    log.info("survives", { circular });
    const entry = JSON.parse(lines[0]);
    expect(entry.msg).toBe("survives");
    expect(entry.logError).toBe("unserializable log fields");
  });
});

describe("requestLogger", () => {
  function makeApp(opts?: { trustRequestId?: boolean }) {
    const { lines, write } = capture();
    const app = new Hono();
    app.use(requestLogger(createLogger("test-service", write), opts));
    app.get("/healthz", (c) => c.json({ ok: true }));
    app.get("/things", (c) => c.json({ requestId: getRequestId(c) }));
    return { app, lines };
  }

  it("logs method/path/status/durationMs and generates a request id", async () => {
    const { app, lines } = makeApp();
    const res = await app.request("/things");
    expect(res.status).toBe(200);
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry).toMatchObject({
      level: "info",
      service: "test-service",
      msg: "request",
      method: "GET",
      path: "/things",
      status: 200,
    });
    expect(typeof entry.durationMs).toBe("number");
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    expect(entry.requestId).toMatch(UUID_RE);
  });

  it("honors an incoming x-request-id and exposes it via getRequestId", async () => {
    const { app, lines } = makeApp();
    const res = await app.request("/things", {
      headers: { "x-request-id": "gateway-id-123" },
    });
    expect(await res.json()).toEqual({ requestId: "gateway-id-123" });
    expect(JSON.parse(lines[0]).requestId).toBe("gateway-id-123");
  });

  it("ignores the incoming id when trustRequestId is false (public edge)", async () => {
    const { app, lines } = makeApp({ trustRequestId: false });
    await app.request("/things", { headers: { "x-request-id": "spoofed" } });
    const entry = JSON.parse(lines[0]);
    expect(entry.requestId).not.toBe("spoofed");
    expect(entry.requestId).toMatch(UUID_RE);
  });

  it("logs error statuses too", async () => {
    const { app, lines } = makeApp();
    await app.request("/nope");
    expect(JSON.parse(lines[0])).toMatchObject({ path: "/nope", status: 404 });
  });

  it("skips /healthz noise", async () => {
    const { app, lines } = makeApp();
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(lines).toHaveLength(0);
  });
});
