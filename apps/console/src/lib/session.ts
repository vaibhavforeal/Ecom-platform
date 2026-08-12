import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { requireSession, resolveSession } from "@platform/core";
import type { Actor } from "@platform/core";

export const SESSION_COOKIE = "__Host-console_session";

/**
 * The `__Host-` prefix is not decoration. Browsers enforce that such a
 * cookie is Secure, path=/, and has no Domain attribute — which means a
 * compromised sibling subdomain cannot set or overwrite it. For a cookie
 * guarding payment credentials, that guarantee is worth the constraint
 * that it only works over HTTPS.
 */
const isProd = process.env.NODE_ENV === "production";

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const store = await cookies();
  store.set({
    // __Host- requires Secure, which requires HTTPS. Fall back in dev.
    name: isProd ? SESSION_COOKIE : "console_session",
    value: token,
    httpOnly: true,
    secure: isProd,
    sameSite: "lax", // 'lax' so OAuth-style returns still carry the session
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(isProd ? SESSION_COOKIE : "console_session");
}

export async function readSessionToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(isProd ? SESSION_COOKIE : "console_session")?.value;
}

export async function getActor(): Promise<Actor | null> {
  return resolveSession(await readSessionToken());
}

/** For route handlers: throws UnauthorizedError, mapped to 401 by the caller. */
export async function getActorOrThrow(): Promise<Actor> {
  return requireSession(await readSessionToken());
}

/** For pages: redirects to login. */
export async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) redirect("/login");
  return actor;
}

/** Client IP, trusting only the proxy hop we control (Caddy). */
export async function requestContext(): Promise<{ ip: string | null; userAgent: string | null }> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for");
  return {
    ip: forwarded?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? null,
    userAgent: h.get("user-agent"),
  };
}
