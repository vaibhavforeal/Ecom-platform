import {
  and,
  desc,
  eq,
  isNull,
  otpChallenges,
  sql,
  tenantMembers,
  tenants,
  users,
  withPlatform,
} from "@platform/db";
import type { OtpPurpose, Role } from "@platform/db";

import { AppError, InvalidOtpError } from "../errors";
import { getOtpProvider } from "./otp-delivery";
import {
  OTP_MAX_ATTEMPTS,
  OTP_TTL_SECONDS,
  generateOtpCode,
  hashOtpCode,
  normalisePhone,
  verifyOtpHash,
} from "./otp";
import { OTP_RATE_LIMITS, consumeRateLimit } from "./rate-limit";

export type LoginContext = { ip?: string | null; userAgent?: string | null };

export type Membership = {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  role: Role;
};

function pepper(): string {
  const p = process.env.OTP_PEPPER;
  if (!p) throw new Error("OTP_PEPPER is not set");
  return p;
}

/**
 * Step 1 of login: issue a code.
 *
 * Returns the same shape whether or not the number is known to us.
 * Revealing "no such account" here turns the login form into a free
 * customer-list oracle for anyone with a phone-number list.
 */
export async function startLogin(input: {
  phone: string;
  purpose: OtpPurpose;
  ctx?: LoginContext;
}): Promise<{ maskedPhone: string; expiresInSeconds: number }> {
  const phoneE164 = normalisePhone(input.phone);
  if (!phoneE164) {
    throw new AppError({
      code: "invalid_phone",
      message: `Unparseable phone: ${input.phone}`,
      publicMessage: "Enter a valid mobile number.",
    });
  }

  // Layered limits: burst, per-phone, per-IP. See rate-limit.ts.
  await consumeRateLimit(OTP_RATE_LIMITS.perPhoneBurst, phoneE164);
  await consumeRateLimit(OTP_RATE_LIMITS.perPhone, phoneE164);
  if (input.ctx?.ip) await consumeRateLimit(OTP_RATE_LIMITS.perIp, input.ctx.ip);

  const code = generateOtpCode();
  const expiresAt = new Date(Date.now() + OTP_TTL_SECONDS * 1000);

  await withPlatform(async (tx) => {
    // Invalidate outstanding challenges so only the newest code works.
    // Without this, an attacker who intercepts an earlier code keeps a
    // valid credential after the user requests a fresh one.
    await tx
      .update(otpChallenges)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(otpChallenges.phoneE164, phoneE164),
          eq(otpChallenges.purpose, input.purpose),
          isNull(otpChallenges.consumedAt),
        ),
      );

    await tx.insert(otpChallenges).values({
      phoneE164,
      purpose: input.purpose,
      codeHash: hashOtpCode({ phoneE164, purpose: input.purpose, code, pepper: pepper() }),
      expiresAt,
      maxAttempts: OTP_MAX_ATTEMPTS,
    });
  });

  await getOtpProvider().send({ phoneE164, code, purpose: input.purpose });

  return {
    maskedPhone: phoneE164.replace(/^(\+\d{2})(\d+)(\d{2})$/, "$1•••••$3"),
    expiresInSeconds: OTP_TTL_SECONDS,
  };
}

/**
 * Step 2: verify the code and return the user's memberships.
 *
 * Note what this does NOT do: create a session. Which tenant the user is
 * signing into is a separate decision, because a user may staff several
 * stores and the session is scoped to exactly one.
 */
export async function completeLogin(input: {
  phone: string;
  purpose: OtpPurpose;
  code: string;
  ctx?: LoginContext;
}): Promise<{ userId: string; memberships: Membership[] }> {
  const phoneE164 = normalisePhone(input.phone);
  if (!phoneE164) throw new InvalidOtpError("unparseable phone");

  await consumeRateLimit(OTP_RATE_LIMITS.verifyPerPhone, phoneE164);
  if (input.ctx?.ip) await consumeRateLimit(OTP_RATE_LIMITS.verifyPerIp, input.ctx.ip);

  return withPlatform(async (tx) => {
    const [challenge] = await tx
      .select()
      .from(otpChallenges)
      .where(
        and(
          eq(otpChallenges.phoneE164, phoneE164),
          eq(otpChallenges.purpose, input.purpose),
          isNull(otpChallenges.consumedAt),
        ),
      )
      .orderBy(desc(otpChallenges.createdAt))
      .limit(1);

    // Every failure below raises the identical error. Distinguishing
    // "no challenge" from "wrong code" tells an attacker whether a
    // number is enrolled and whether a code is still live.
    if (!challenge) throw new InvalidOtpError("no active challenge");
    if (challenge.expiresAt <= new Date()) throw new InvalidOtpError("expired");
    if (challenge.attempts >= challenge.maxAttempts) {
      throw new InvalidOtpError("attempts exhausted");
    }

    const candidate = hashOtpCode({
      phoneE164,
      purpose: input.purpose,
      code: input.code.trim(),
      pepper: pepper(),
    });

    if (!verifyOtpHash(challenge.codeHash, candidate)) {
      await tx
        .update(otpChallenges)
        .set({ attempts: sql`${otpChallenges.attempts} + 1` })
        .where(eq(otpChallenges.id, challenge.id));
      throw new InvalidOtpError("code mismatch");
    }

    // Single use, always.
    await tx
      .update(otpChallenges)
      .set({ consumedAt: new Date() })
      .where(eq(otpChallenges.id, challenge.id));

    const [user] = await tx
      .insert(users)
      .values({ phoneE164, lastLoginAt: new Date() })
      .onConflictDoUpdate({
        target: users.phoneE164,
        set: { lastLoginAt: new Date(), updatedAt: new Date() },
      })
      .returning({ id: users.id });

    if (!user) throw new InvalidOtpError("user upsert failed");

    const memberships = await tx
      .select({
        tenantId: tenantMembers.tenantId,
        tenantSlug: tenants.slug,
        tenantName: tenants.displayName,
        role: tenantMembers.role,
      })
      .from(tenantMembers)
      .innerJoin(tenants, eq(tenants.id, tenantMembers.tenantId))
      .where(
        and(
          eq(tenantMembers.userId, user.id),
          isNull(tenantMembers.revokedAt),
          isNull(tenants.deletedAt),
        ),
      );

    return { userId: user.id, memberships };
  });
}
