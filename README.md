# api-gateway (:4000)

> [!WARNING]
> This repository is a **read-only mirror** of [`services/api-gateway`](https://github.com/luminary-dev/service-hub/tree/main/services/api-gateway) in the service-hub monorepo. Do not push or open PRs here — changes land via monorepo PRs and are synced out with `npm run sync:repos`. Direct pushes are blocked by branch protection.

Public entry point for Service Hub. Terminates CSRF checks, rate limiting and
session verification, then reverse-proxies `/api/*` to the backend services.
No database. The gateway is the only publicly exposed service — it **adds**
`x-internal-secret` to every upstream request (it does not require one itself).

## Routing table (longest prefix first)

| Public path | Upstream | Upstream path |
|---|---|---|
| `/api/files/provider/*` | provider-service | `/files/*` (rewritten) |
| `/api/files/review/*` | review-service | `/files/*` (rewritten) |
| `/api/providers/:id/reviews` | review-service | unchanged |
| `/api/admin/reviews/*` | review-service | unchanged |
| `/api/reviews/*` | review-service | unchanged |
| `/api/admin/*` | provider-service | unchanged |
| `/api/auth/*` | identity-service | unchanged |
| `/api/favorites*` | identity-service | unchanged |
| `/api/providers*`, `/api/provider/*`, `/api/stats` | provider-service | unchanged |
| `/api/jobs*` | job-service | unchanged |
| anything else | — | `404 { "error": "Not found" }` |

Paths containing `/internal` are **never** forwarded (404).

`GET /healthz` → `200 { ok: true, service: "api-gateway" }` (no auth, not proxied).

## Behaviors

- **CSRF** (`src/lib/csrf.ts`, ported from the monolith): for non-GET/HEAD/OPTIONS
  requests, allow if `sec-fetch-site` is `same-origin` or `none`; otherwise
  compare the `origin` host with `x-forwarded-host` ?? `host`. Rejected →
  `403 { "error": "Cross-site request blocked." }`.
- **Rate limiting** (`src/lib/rate-limit.ts`, in-memory sliding window keyed by
  client IP — first `x-forwarded-for` value, else `x-real-ip`, else `unknown`).
  Over the limit → `429 { "error": "Too many requests. Please slow down and try
  again shortly." }` with a `Retry-After` header.

  | Route (POST) | Key | Rule |
  |---|---|---|
  | `/api/auth/login` | `auth-login` | authStrict (8 / 15 min) |
  | `/api/auth/forgot-password` | `auth-forgot` | authStrict (8 / 15 min) |
  | `/api/auth/reset-password` | `auth-reset` | authStrict (8 / 15 min) |
  | `/api/auth/register` | `auth-register` | authSignup (10 / 60 min) |
  | `/api/auth/resend-verification` | `auth-resend` | resend (4 / 15 min) |
  | `/api/jobs` | `job-post` | inquiry (6 / 10 min) |
  | `/api/providers/:id/inquiries` | `inquiry` | inquiry (6 / 10 min) |
  | `/api/jobs/:id/responses` | `job-response` | review (10 / 60 min) |
  | `/api/providers/:id/reviews` | `review` | review (10 / 60 min) |

- **Identity** (`src/lib/session.ts` + `src/lib/proxy.ts`): client-sent
  `x-user-id`, `x-user-role`, `x-user-name`, `x-internal-secret`, `x-locale`
  and `x-origin` headers are always stripped. The `sh_session` cookie is
  verified (jose, HS256, `AUTH_SECRET`; in production the process refuses to
  start without `AUTH_SECRET`). A valid session sets `x-user-id`,
  `x-user-role`, `x-user-name` (URI-encoded) upstream; an invalid or absent
  one just omits them — services decide their own 401s. Every upstream request
  also gets `x-internal-secret`, `x-locale` (`si` if the `lang` cookie is
  `si`, else `en`) and `x-origin` (`x-forwarded-proto`/`x-forwarded-host`
  based, falling back to `WEB_ORIGIN`).
- **Proxy** (`src/lib/proxy.ts` + `src/lib/routes.ts`): streaming pass-through
  of method, path, query string, headers and body (multipart included) via
  Hono's `proxy` helper. Hop-by-hop headers (`connection`, `keep-alive`,
  `transfer-encoding`, `upgrade`, `host`) are dropped; `host` is set to the
  upstream. Upstream responses — status codes and `Set-Cookie` included — pass
  back verbatim. Unreachable upstream →
  `502 { "error": "Upstream service unavailable" }`.

## Environment variables

| var | default | purpose |
|---|---|---|
| `PORT` | `4000` | listen port |
| `AUTH_SECRET` | `dev-only-secret` (dev only; required in production) | verify `sh_session` JWTs |
| `INTERNAL_API_SECRET` | `dev-internal-secret` | attached to every upstream request |
| `IDENTITY_SERVICE_URL` | `http://localhost:4001` | upstream |
| `PROVIDER_SERVICE_URL` | `http://localhost:4002` | upstream |
| `REVIEW_SERVICE_URL` | `http://localhost:4003` | upstream |
| `JOB_SERVICE_URL` | `http://localhost:4004` | upstream |
| `NOTIFICATION_SERVICE_URL` | `http://localhost:4005` | (not routed publicly; internal-only service) |
| `WEB_ORIGIN` | `http://localhost:3000` | `x-origin` fallback |

## Scripts

- `npm run dev` — tsx watch
- `npm run typecheck` / `npm test` / `npm run build` / `npm start`
