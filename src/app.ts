import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { csrfMiddleware } from "./lib/csrf";
import { log } from "./lib/log";
import { getRequestId, requestLogger } from "./lib/logging";
import { proxyRequest } from "./lib/proxy";
import { rateLimitMiddleware } from "./lib/rate-limit";

// Cap request bodies at the public edge. proxyRequest buffers the whole body
// with arrayBuffer() before forwarding, so without this a multi-GB upload would
// OOM the only public entry point. 6MB covers the 5MB image cap plus multipart
// overhead; larger uploads get 413 before any buffering.
const MAX_BODY_BYTES = 6 * 1024 * 1024;

export const app = new Hono();

// Public edge: never trust a client-sent x-request-id — generate our own here
// and propagate it upstream (see lib/proxy.ts buildUpstreamHeaders).
app.use(requestLogger(log, { trustRequestId: false }));

// Public entry — no internal-secret check here; the gateway ADDS the secret
// to upstream requests instead.
app.get("/healthz", (c) => c.json({ ok: true, service: "api-gateway" }));

app.use("/api/*", csrfMiddleware);
app.use("/api/*", rateLimitMiddleware);
app.use(
  "/api/*",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ error: "Payload too large" }, 413),
  })
);
app.all("/api/*", proxyRequest);

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  log.error("unhandled error", { requestId: getRequestId(c), err });
  return c.json({ error: "Internal server error" }, 500);
});
