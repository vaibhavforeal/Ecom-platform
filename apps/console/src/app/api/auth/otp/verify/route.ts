import { NextResponse } from "next/server";
import { z } from "zod";

import { completeLogin, createSession } from "@platform/core";
import { recordAuditStandalone } from "@platform/core";

import { errorResponse, newRequestId } from "../../../../../lib/api";
import { requestContext, setSessionCookie } from "../../../../../lib/session";

export const dynamic = "force-dynamic";

const Body = z.object({
  phone: z.string().min(6).max(20),
  code: z.string().regex(/^\d{6}$/),
  /** Optional when the user staffs exactly one store. */
  tenantId: z.string().uuid().optional(),
});

export async function POST(req: Request): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: "invalid_otp", message: "That code is not valid." }, requestId },
        { status: 401 },
      );
    }

    const ctx = await requestContext();
    const { userId, memberships } = await completeLogin({
      phone: parsed.data.phone,
      code: parsed.data.code,
      purpose: "console_login",
      ctx,
    });

    // Verified identity, but no store to enter. Do not create a session.
    if (memberships.length === 0) {
      return NextResponse.json(
        {
          error: {
            code: "no_membership",
            message: "This number is not a staff member of any store.",
          },
          requestId,
        },
        { status: 403 },
      );
    }

    // A user may staff several stores; the session is scoped to exactly
    // one, so make them choose rather than guessing.
    if (memberships.length > 1 && !parsed.data.tenantId) {
      return NextResponse.json({ needsTenantChoice: true, memberships, requestId });
    }

    const chosen = parsed.data.tenantId
      ? memberships.find((m) => m.tenantId === parsed.data.tenantId)
      : memberships[0];

    // Guards against a caller pasting a tenantId they have no claim to.
    if (!chosen) {
      return NextResponse.json(
        { error: { code: "forbidden", message: "You cannot access that store." }, requestId },
        { status: 403 },
      );
    }

    const { token, expiresAt } = await createSession({
      userId,
      tenantId: chosen.tenantId,
      userAgent: ctx.userAgent,
      ip: ctx.ip,
    });
    await setSessionCookie(token, expiresAt);

    await recordAuditStandalone(chosen.tenantId, {
      actorType: "staff",
      actorUserId: userId,
      action: "auth.login",
      entityType: "session",
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId,
    });

    return NextResponse.json({
      ok: true,
      tenant: { id: chosen.tenantId, name: chosen.tenantName, role: chosen.role },
      requestId,
    });
  } catch (err) {
    return errorResponse(err, requestId);
  }
}
