import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import {
  and,
  eq,
  isNull,
  sessions,
  tenantMembers,
  tenants,
  users,
  withPlatform,
} from "@platform/db";
import type { Role } from "@platform/db";

import { UnauthorizedError } from "../errors";
import { effectivePermissions } from "./permissions";
import type { Permission, PermissionOverrides } from "./permissions";

/**
 * Opaque session tokens.
 *
 * Not JWTs, deliberately. A merchant console holds payment credentials
 * and refund authority; "sign out everywhere" and instant revocation on
 * a staff departure have to actually work, and a stateless token cannot
 * offer that without rebuilding server-side state anyway.
 */

// Absolute cap on a session's life, regardless of activity — an idle
// timeout alone lets a stolen token live indefinitely under light use.
const ABSOLUTE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const IDLE_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

export type Actor = {
  userId: string;
  sessionId: string;
  tenantId: string;
  role: Role;
  permissions: Set<Permission>;
  phoneE164: string;
  name: string | null;
};

/** 256 bits from the CSPRNG. Returned once, then only its hash is stored. */
function mintToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const salt = process.env.SESSION_SECRET ?? "";
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 32);
}

export async function createSession(input: {
  userId: string;
  tenantId: string;
  userAgent?: string | null;
  ip?: string | null;
}): Promise<{ token: string; expiresAt: Date }> {
  const token = mintToken();
  const now = Date.now();
  const expiresAt = new Date(now + ABSOLUTE_TTL_MS);

  await withPlatform(async (tx) => {
    await tx.insert(sessions).values({
      tokenHash: hashToken(token),
      userId: input.userId,
      tenantId: input.tenantId,
      userAgent: input.userAgent?.slice(0, 512) ?? null,
      ipHash: hashIp(input.ip),
      expiresAt,
      idleExpiresAt: new Date(now + IDLE_TTL_MS),
    });
  });

  return { token, expiresAt };
}

/**
 * Resolve a token to an actor, or null.
 *
 * The membership lookup happens on EVERY request rather than being
 * baked into the token at login. That is the point: revoking a staff
 * member's access takes effect on their next request, not whenever their
 * session happens to expire.
 */
export async function resolveSession(token: string | undefined | null): Promise<Actor | null> {
  if (!token) return null;

  const tokenHash = hashToken(token);
  const now = new Date();

  return withPlatform(async (tx) => {
    const [row] = await tx
      .select({
        sessionId: sessions.id,
        storedHash: sessions.tokenHash,
        userId: sessions.userId,
        tenantId: sessions.tenantId,
        expiresAt: sessions.expiresAt,
        idleExpiresAt: sessions.idleExpiresAt,
        revokedAt: sessions.revokedAt,
        phoneE164: users.phoneE164,
        name: users.name,
        role: tenantMembers.role,
        overrides: tenantMembers.permissionOverrides,
        memberRevokedAt: tenantMembers.revokedAt,
        tenantStatus: tenants.status,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .leftJoin(
        tenantMembers,
        and(
          eq(tenantMembers.userId, sessions.userId),
          eq(tenantMembers.tenantId, sessions.tenantId),
        ),
      )
      .leftJoin(tenants, eq(tenants.id, sessions.tenantId))
      .where(eq(sessions.tokenHash, tokenHash))
      .limit(1);

    if (!row) return null;

    // Belt and braces: the lookup was already by hash, but compare in
    // constant time so this path cannot become a timing oracle if the
    // query is ever loosened.
    const a = Buffer.from(row.storedHash, "hex");
    const b = Buffer.from(tokenHash, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    if (row.revokedAt) return null;
    if (row.expiresAt <= now || row.idleExpiresAt <= now) return null;
    if (!row.tenantId || !row.role) return null;
    if (row.memberRevokedAt) return null; // access revoked since login
    if (row.tenantStatus === "suspended" || row.tenantStatus === "churned") return null;

    // Slide the idle window. Cheap enough per request at this scale;
    // becomes a throttled write once traffic justifies it.
    await tx
      .update(sessions)
      .set({ idleExpiresAt: new Date(now.getTime() + IDLE_TTL_MS) })
      .where(and(eq(sessions.id, row.sessionId), isNull(sessions.revokedAt)));

    return {
      userId: row.userId,
      sessionId: row.sessionId,
      tenantId: row.tenantId,
      role: row.role,
      permissions: effectivePermissions(
        row.role,
        (row.overrides ?? {}) as PermissionOverrides,
      ),
      phoneE164: row.phoneE164,
      name: row.name,
    } satisfies Actor;
  });
}

export async function requireSession(token: string | undefined | null): Promise<Actor> {
  const actor = await resolveSession(token);
  if (!actor) throw new UnauthorizedError();
  return actor;
}

export async function revokeSession(token: string): Promise<void> {
  await withPlatform(async (tx) => {
    await tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(eq(sessions.tokenHash, hashToken(token)));
  });
}

/** "Sign out everywhere" — also the correct response to a suspected compromise. */
export async function revokeAllSessionsForUser(userId: string): Promise<number> {
  return withPlatform(async (tx) => {
    const revoked = await tx
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });
    return revoked.length;
  });
}
