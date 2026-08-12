import { NextResponse } from "next/server";

import { revokeAllSessionsForUser, revokeSession } from "@platform/core";

import { newRequestId } from "../../../../lib/api";
import { clearSessionCookie, getActor, readSessionToken } from "../../../../lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const requestId = newRequestId();
  const token = await readSessionToken();

  if (token) {
    const url = new URL(req.url);
    if (url.searchParams.get("all") === "1") {
      // "Sign out everywhere" — the correct response to a lost phone,
      // and the reason sessions are server-side rather than JWTs.
      const actor = await getActor();
      if (actor) await revokeAllSessionsForUser(actor.userId);
    } else {
      await revokeSession(token);
    }
  }

  await clearSessionCookie();
  return NextResponse.json({ ok: true, requestId });
}
