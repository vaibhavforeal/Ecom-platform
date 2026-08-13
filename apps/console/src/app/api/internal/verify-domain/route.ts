import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { isDomainVerifiedForTls } from "@platform/core";

export const dynamic = "force-dynamic";

const RELAXED_ENVIRONMENTS = new Set(["development", "test"]);

/**
 * Caddy's on_demand_tls `ask` cannot attach headers, so the secret
 * rides the ask URL's query string — set once in the Caddyfile via
 * {$TLS_ASK_SECRET}. This is a DEDICATED credential: it must never be
 * INTERNAL_API_SECRET, which authorises cache purges on the storefront.
 * A leaked ask URL should decide nothing but TLS issuance.
 */
function askSecretOk(url: URL): boolean {
  const expected = process.env.TLS_ASK_SECRET;
  if (!expected) return RELAXED_ENVIRONMENTS.has(process.env.NODE_ENV ?? "");
  const provided = Buffer.from(url.searchParams.get("secret") ?? "");
  const wanted = Buffer.from(expected);
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

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

  if (!askSecretOk(url)) return new NextResponse(null, { status: 403 });

  const domain = url.searchParams.get("domain");

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
