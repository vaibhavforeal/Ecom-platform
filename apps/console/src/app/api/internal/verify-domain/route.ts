import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { isDomainVerifiedForTls } from "@platform/core";

export const dynamic = "force-dynamic";

/**
 * Caddy's on-demand TLS `ask` endpoint.
 *
 * Caddy calls this before obtaining a certificate for a hostname it has
 * never seen. A 200 authorises issuance; anything else refuses it.
 *
 * This gate is the difference between "merchants can bring their own
 * domain with zero ops work" and "anyone who points DNS at our IP can
 * exhaust our Let's Encrypt rate limit and take custom domains down for
 * every tenant". Do not relax it. See PLATFORM_BLUEPRINT.md §2.4.
 */
export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const domain = url.searchParams.get("domain");

  // Defence in depth: this endpoint should be unreachable from the
  // public internet, but it must also refuse anything that is not Caddy.
  const expected = process.env.INTERNAL_API_SECRET;
  if (expected) {
    const provided = req.headers.get("x-internal-secret") ?? "";
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return new NextResponse(null, { status: 403 });
    }
  }

  if (!domain) return new NextResponse(null, { status: 400 });

  const allowed = await isDomainVerifiedForTls(domain);

  // Log refusals: a spike here means someone is probing us.
  if (!allowed) {
    console.warn(
      JSON.stringify({ level: "warn", event: "tls.issuance_refused", domain }),
    );
  }

  return new NextResponse(null, { status: allowed ? 200 : 403 });
}
