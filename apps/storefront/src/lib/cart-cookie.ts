import { cookies } from "next/headers";
import type { NextResponse } from "next/server";

/**
 * The cart identity cookie.
 *
 * The value is the cart row's UUIDv7 primary key — non-enumerable, and
 * meaningless against any other tenant's host because RLS matches zero
 * rows for it there. httpOnly so storefront scripts (including a
 * merchant's own theme snippets, later) can never read it; SameSite=Lax
 * so a link followed from WhatsApp still carries the cart while
 * cross-site POSTs do not.
 *
 * No `__Host-` prefix, deliberately: that prefix requires Secure, and
 * local development storefronts run plain http on *.localhost.
 */

export const CART_COOKIE = "cart_id";

/** Matches the 30-day abandoned-cart GC horizon (carts_tenant_updated_idx). */
const CART_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** For PAGES: the request's cart id via next/headers, or null. */
export async function readCartId(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(CART_COOKIE)?.value ?? null;
  return value && UUID_RE.test(value) ? value : null;
}

/**
 * For ROUTE HANDLERS: the cart id off the incoming Request, so handlers
 * stay callable with a plain Request (tests construct one; no ambient
 * next/headers scope needed).
 */
export function readCartIdFrom(req: Request): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === CART_COOKIE) {
      const value = rest.join("=").trim();
      return UUID_RE.test(value) ? value : null;
    }
  }
  return null;
}

/** Sets the cookie on a route handler's response. */
export function setCartCookie(res: NextResponse, cartId: string): void {
  res.cookies.set({
    name: CART_COOKIE,
    value: cartId,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: CART_COOKIE_MAX_AGE_SECONDS,
  });
}
