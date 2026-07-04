export type ServiceName = "identity" | "provider" | "review" | "job";

export type ResolvedRoute = { service: ServiceName; path: string };

// Pure routing table (longest prefix first). Returns the upstream service and
// the (possibly rewritten) upstream path, or null → 404. Paths containing
// /internal are never forwarded.
export function resolveRoute(pathname: string): ResolvedRoute | null {
  if (containsInternal(pathname)) return null;

  // /api/files/<service>/* → upstream /files/*
  if (pathname.startsWith("/api/files/provider/")) {
    return {
      service: "provider",
      path: "/files/" + pathname.slice("/api/files/provider/".length),
    };
  }
  if (pathname.startsWith("/api/files/review/")) {
    return {
      service: "review",
      path: "/files/" + pathname.slice("/api/files/review/".length),
    };
  }

  // Customer account history (#46): exact paths, each owned by the service
  // that holds the data.
  if (pathname === "/api/account/inquiries") {
    return { service: "provider", path: pathname };
  }
  if (pathname === "/api/account/reviews") {
    return { service: "review", path: pathname };
  }

  // Review routes carved out of the provider/admin namespaces. This includes
  // review abuse reports (#50): /api/reviews/:id/report and the admin queue
  // at /api/admin/review-reports both belong to review-service; the provider/
  // photo queue at /api/admin/reports falls through to provider-service below.
  if (/^\/api\/providers\/[^/]+\/reviews$/.test(pathname)) {
    return { service: "review", path: pathname };
  }
  if (pathname.startsWith("/api/admin/reviews/")) {
    return { service: "review", path: pathname };
  }
  if (
    pathname === "/api/admin/review-reports" ||
    pathname.startsWith("/api/admin/review-reports/")
  ) {
    return { service: "review", path: pathname };
  }
  if (pathname.startsWith("/api/reviews/")) {
    return { service: "review", path: pathname };
  }

  if (pathname.startsWith("/api/admin/")) {
    return { service: "provider", path: pathname };
  }

  // Work-photo abuse reports (#50) — photos are provider-service data.
  if (/^\/api\/photos\/[^/]+\/report$/.test(pathname)) {
    return { service: "provider", path: pathname };
  }

  if (pathname.startsWith("/api/auth/")) {
    return { service: "identity", path: pathname };
  }
  if (pathname === "/api/favorites" || pathname.startsWith("/api/favorites/")) {
    return { service: "identity", path: pathname };
  }

  if (
    pathname === "/api/providers" ||
    pathname.startsWith("/api/providers/") ||
    pathname.startsWith("/api/provider/") ||
    pathname.startsWith("/api/inquiries/") ||
    pathname === "/api/categories" ||
    pathname === "/api/stats"
  ) {
    return { service: "provider", path: pathname };
  }

  if (pathname === "/api/jobs" || pathname.startsWith("/api/jobs/")) {
    return { service: "job", path: pathname };
  }

  return null;
}

function containsInternal(pathname: string): boolean {
  if (pathname.includes("/internal")) return true;
  try {
    // Also catch percent-encoded attempts (e.g. %2Finternal).
    return decodeURIComponent(pathname).includes("/internal");
  } catch {
    return true; // malformed encoding — refuse to route
  }
}

export function serviceUrl(service: ServiceName): string {
  switch (service) {
    case "identity":
      return process.env.IDENTITY_SERVICE_URL ?? "http://localhost:4001";
    case "provider":
      return process.env.PROVIDER_SERVICE_URL ?? "http://localhost:4002";
    case "review":
      return process.env.REVIEW_SERVICE_URL ?? "http://localhost:4003";
    case "job":
      return process.env.JOB_SERVICE_URL ?? "http://localhost:4004";
  }
}
