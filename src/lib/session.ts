import { jwtVerify } from "jose";

if (!process.env.AUTH_SECRET && process.env.NODE_ENV === "production") {
  throw new Error("AUTH_SECRET must be set in production");
}

const secret = new TextEncoder().encode(
  process.env.AUTH_SECRET ?? "dev-only-secret"
);

export const SESSION_COOKIE = "sh_session";

export type SessionPayload = {
  userId: string;
  role: string;
  name: string;
};

// Verifies the sh_session JWT (HS256, signed by identity-service). Invalid or
// expired tokens yield null — the gateway forwards without identity headers
// and the services decide their own 401s.
export async function verifySessionToken(
  token: string
): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ["HS256"],
    });
    return {
      userId: payload.userId as string,
      role: payload.role as string,
      name: payload.name as string,
    };
  } catch {
    return null;
  }
}
