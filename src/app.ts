import { Hono } from "hono";
import { logger } from "hono/logger";
import { csrfMiddleware } from "./lib/csrf";
import { proxyRequest } from "./lib/proxy";
import { rateLimitMiddleware } from "./lib/rate-limit";

export const app = new Hono();

app.use(logger());

// Public entry — no internal-secret check here; the gateway ADDS the secret
// to upstream requests instead.
app.get("/healthz", (c) => c.json({ ok: true, service: "api-gateway" }));

app.use("/api/*", csrfMiddleware);
app.use("/api/*", rateLimitMiddleware);
app.all("/api/*", proxyRequest);

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
});
