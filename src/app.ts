import { Hono } from "hono";
import { csrfMiddleware } from "./lib/csrf";
import { log } from "./lib/log";
import { getRequestId, requestLogger } from "./lib/logging";
import { proxyRequest } from "./lib/proxy";
import { rateLimitMiddleware } from "./lib/rate-limit";

export const app = new Hono();

// Public edge: never trust a client-sent x-request-id — generate our own here
// and propagate it upstream (see lib/proxy.ts buildUpstreamHeaders).
app.use(requestLogger(log, { trustRequestId: false }));

// Public entry — no internal-secret check here; the gateway ADDS the secret
// to upstream requests instead.
app.get("/healthz", (c) => c.json({ ok: true, service: "api-gateway" }));

app.use("/api/*", csrfMiddleware);
app.use("/api/*", rateLimitMiddleware);
app.all("/api/*", proxyRequest);

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  log.error("unhandled error", { requestId: getRequestId(c), err });
  return c.json({ error: "Internal server error" }, 500);
});
