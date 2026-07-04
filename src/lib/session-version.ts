// Session revocation check. identity-service bumps User.sessionVersion on
// password change/reset and logout-everywhere; tokens carry the version they
// were minted with (sv claim). The gateway rejects tokens minted before the
// user's current version.
//
// The lookup is cached briefly so revocation costs one S2S call per user per
// TTL window (revocation takes effect within the TTL at worst), and it FAILS
// OPEN: if identity-service is unreachable, sessions keep working — an
// identity outage must not sign every user out.

const TTL_MS = 60_000;

type CacheEntry = { v: number; exp: number };
const cache = new Map<string, CacheEntry>();

// Tests only — the cache is process-global.
export function clearSessionVersionCache() {
  cache.clear();
}

// number = current version; null = user no longer exists; undefined = lookup
// unavailable (bad response shape counts too — fail open).
async function fetchVersion(userId: string): Promise<number | null | undefined> {
  const base = process.env.IDENTITY_SERVICE_URL ?? "http://localhost:4001";
  try {
    const res = await fetch(
      `${base}/internal/users/${encodeURIComponent(userId)}/session-version`,
      {
        headers: {
          "x-internal-secret": process.env.INTERNAL_API_SECRET ?? "dev-internal-secret",
        },
        signal: AbortSignal.timeout(2000),
      }
    );
    if (!res.ok) return undefined;
    const data = (await res.json()) as { v?: number | null };
    if (typeof data.v === "number") return data.v;
    if (data.v === null) return null;
    return undefined;
  } catch {
    return undefined;
  }
}

// True when the token's sv is still current. sv sits inside the signed JWT,
// so a token carrying a NEWER version than our cache proves the cache is
// stale — adopt the newer version instead of rejecting. This is what keeps a
// user signed in immediately after change-password mints their v+1 cookie
// while the old v is still cached.
export async function sessionVersionOk(userId: string, sv: number): Promise<boolean> {
  const now = Date.now();
  const hit = cache.get(userId);
  if (hit && hit.exp > now) {
    if (sv > hit.v) {
      cache.set(userId, { v: sv, exp: now + TTL_MS });
      return true;
    }
    return sv === hit.v;
  }

  const v = await fetchVersion(userId);
  if (v === undefined) return true; // fail open — availability over revocation
  if (v === null) return false; // user deleted — token is dead
  cache.set(userId, { v: Math.max(v, sv), exp: now + TTL_MS });
  return sv >= v;
}
