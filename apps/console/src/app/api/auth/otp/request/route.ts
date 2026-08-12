import { NextResponse } from "next/server";
import { z } from "zod";

import { startLogin } from "@platform/core";

import { errorResponse, newRequestId } from "../../../../../lib/api";
import { requestContext } from "../../../../../lib/session";

export const dynamic = "force-dynamic";

const Body = z.object({ phone: z.string().min(6).max(20) });

export async function POST(req: Request): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const parsed = Body.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: { code: "invalid_body", message: "Enter a valid mobile number." }, requestId },
        { status: 400 },
      );
    }

    const ctx = await requestContext();
    const result = await startLogin({
      phone: parsed.data.phone,
      purpose: "console_login",
      ctx,
    });

    // Deliberately identical whether or not this number can sign in.
    // Anything else turns the login form into a customer-list oracle.
    return NextResponse.json({ ...result, requestId });
  } catch (err) {
    return errorResponse(err, requestId);
  }
}
