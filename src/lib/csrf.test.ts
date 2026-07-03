import { describe, it, expect } from "vitest";
import { isSameOriginRequest } from "./csrf";

const base = {
  method: "POST",
  secFetchSite: null as string | null,
  origin: null as string | null,
  host: "baas.lk",
};

describe("isSameOriginRequest", () => {
  it("always allows safe methods", () => {
    expect(isSameOriginRequest({ ...base, method: "GET", secFetchSite: "cross-site" })).toBe(true);
    expect(isSameOriginRequest({ ...base, method: "HEAD" })).toBe(true);
  });

  it("allows same-origin / none via Sec-Fetch-Site", () => {
    expect(isSameOriginRequest({ ...base, secFetchSite: "same-origin" })).toBe(true);
    expect(isSameOriginRequest({ ...base, secFetchSite: "none" })).toBe(true);
  });

  it("blocks cross-site and same-site via Sec-Fetch-Site", () => {
    expect(isSameOriginRequest({ ...base, secFetchSite: "cross-site" })).toBe(false);
    expect(isSameOriginRequest({ ...base, secFetchSite: "same-site" })).toBe(false);
  });

  it("falls back to Origin host match when Sec-Fetch-Site is absent", () => {
    expect(
      isSameOriginRequest({ ...base, origin: "https://baas.lk", host: "baas.lk" })
    ).toBe(true);
    expect(
      isSameOriginRequest({ ...base, origin: "https://evil.example", host: "baas.lk" })
    ).toBe(false);
  });

  it("allows non-browser clients (no Sec-Fetch-Site, no Origin)", () => {
    expect(isSameOriginRequest({ ...base })).toBe(true);
  });

  it("blocks a malformed Origin", () => {
    expect(isSameOriginRequest({ ...base, origin: "not a url" })).toBe(false);
  });
});
