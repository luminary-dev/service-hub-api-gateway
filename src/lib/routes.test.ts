import { describe, it, expect } from "vitest";
import { resolveRoute } from "./routes";

describe("resolveRoute (routing table)", () => {
  it("routes auth and favorites to identity", () => {
    expect(resolveRoute("/api/auth/login")).toEqual({ service: "identity", path: "/api/auth/login" });
    expect(resolveRoute("/api/auth/me")).toEqual({ service: "identity", path: "/api/auth/me" });
    expect(resolveRoute("/api/favorites")).toEqual({ service: "identity", path: "/api/favorites" });
    expect(resolveRoute("/api/favorites/prov-1")).toEqual({ service: "identity", path: "/api/favorites/prov-1" });
  });

  it("routes provider reviews to review-service (carve-out)", () => {
    expect(resolveRoute("/api/providers/prov-1/reviews")).toEqual({
      service: "review",
      path: "/api/providers/prov-1/reviews",
    });
  });

  it("routes reviews and admin reviews to review-service", () => {
    expect(resolveRoute("/api/reviews/photos/ph-1")).toEqual({
      service: "review",
      path: "/api/reviews/photos/ph-1",
    });
    expect(resolveRoute("/api/admin/reviews/rev-1")).toEqual({
      service: "review",
      path: "/api/admin/reviews/rev-1",
    });
  });

  it("routes the rest of admin to provider-service", () => {
    expect(resolveRoute("/api/admin/providers")).toEqual({ service: "provider", path: "/api/admin/providers" });
    expect(resolveRoute("/api/admin/providers/prov-1")).toEqual({
      service: "provider",
      path: "/api/admin/providers/prov-1",
    });
    expect(resolveRoute("/api/admin/verifications")).toEqual({
      service: "provider",
      path: "/api/admin/verifications",
    });
    expect(resolveRoute("/api/admin/photos/ph-1")).toEqual({ service: "provider", path: "/api/admin/photos/ph-1" });
  });

  it("routes providers, provider dashboard and stats to provider-service", () => {
    expect(resolveRoute("/api/providers")).toEqual({ service: "provider", path: "/api/providers" });
    expect(resolveRoute("/api/providers/ids")).toEqual({ service: "provider", path: "/api/providers/ids" });
    expect(resolveRoute("/api/providers/prov-1")).toEqual({ service: "provider", path: "/api/providers/prov-1" });
    expect(resolveRoute("/api/providers/prov-1/full")).toEqual({
      service: "provider",
      path: "/api/providers/prov-1/full",
    });
    expect(resolveRoute("/api/providers/prov-1/inquiries")).toEqual({
      service: "provider",
      path: "/api/providers/prov-1/inquiries",
    });
    expect(resolveRoute("/api/provider/dashboard")).toEqual({ service: "provider", path: "/api/provider/dashboard" });
    expect(resolveRoute("/api/provider/photos")).toEqual({ service: "provider", path: "/api/provider/photos" });
    expect(resolveRoute("/api/stats")).toEqual({ service: "provider", path: "/api/stats" });
  });

  it("routes jobs to job-service", () => {
    expect(resolveRoute("/api/jobs")).toEqual({ service: "job", path: "/api/jobs" });
    expect(resolveRoute("/api/jobs/board")).toEqual({ service: "job", path: "/api/jobs/board" });
    expect(resolveRoute("/api/jobs/job-1/responses")).toEqual({
      service: "job",
      path: "/api/jobs/job-1/responses",
    });
  });

  it("rewrites /api/files/* to upstream /files/*", () => {
    expect(resolveRoute("/api/files/provider/avatars/a.jpg")).toEqual({
      service: "provider",
      path: "/files/avatars/a.jpg",
    });
    expect(resolveRoute("/api/files/review/reviews/r.png")).toEqual({
      service: "review",
      path: "/files/reviews/r.png",
    });
  });

  it("never forwards /internal paths", () => {
    expect(resolveRoute("/api/jobs/internal/jobs/count")).toBeNull();
    expect(resolveRoute("/api/providers/internal")).toBeNull();
    expect(resolveRoute("/api/auth/%2Finternal/users")).toBeNull();
    expect(resolveRoute("/internal/users")).toBeNull();
  });

  it("returns null for anything else", () => {
    expect(resolveRoute("/api/unknown")).toBeNull();
    expect(resolveRoute("/api/authx/login")).toBeNull();
    expect(resolveRoute("/api/favoritesx")).toBeNull();
    expect(resolveRoute("/api/providersx")).toBeNull();
    expect(resolveRoute("/api/jobsx")).toBeNull();
    expect(resolveRoute("/api/statsx")).toBeNull();
    expect(resolveRoute("/other")).toBeNull();
  });
});
