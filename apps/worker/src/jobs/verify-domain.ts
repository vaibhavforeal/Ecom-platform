import { Resolver } from "node:dns/promises";

import { invalidateHostCache, recordAudit } from "@platform/core";
import { and, domains, eq, withPlatform, withTenant } from "@platform/db";

import type { TenantJob } from "../queues";

/**
 * Custom domain verification.
 *
 * A merchant adds shop.theirbrand.com and is shown a CNAME target. This
 * job polls DNS until it resolves to us, then sets `verifiedAt` — which
 * is what unlocks TLS issuance at the Caddy `ask` endpoint.
 *
 * Ordering matters and is easy to get backwards: verify DNS FIRST, then
 * allow certificates. The reverse lets anyone point a record at our IP
 * and burn our Let's Encrypt rate limit (PLATFORM_BLUEPRINT.md §2.4).
 */

export type VerifyDomainJob = TenantJob<{ domainId: string }>;

/** Public IPs / CNAME targets that count as "pointed at us". */
function expectedTargets(): { cname: string; ips: string[] } {
  return {
    cname: (process.env.CUSTOM_DOMAIN_CNAME_TARGET ?? "domains.platform.in").toLowerCase(),
    ips: (process.env.CUSTOM_DOMAIN_A_RECORDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  };
}

export async function verifyDomain(job: VerifyDomainJob): Promise<{ verified: boolean }> {
  // Contract: tenant context first, before touching any tenant data.
  const { domainId, tenantId } = job;

  // `domains` is a control-plane table, so the tenant filter is explicit
  // — RLS is not doing that work here (see packages/db/src/rls.ts).
  const [domain] = await withPlatform(async (tx) =>
    tx
      .select()
      .from(domains)
      .where(and(eq(domains.id, domainId), eq(domains.tenantId, tenantId)))
      .limit(1),
  );

  if (!domain) return { verified: false };
  if (domain.verifiedAt) return { verified: true };

  const targets = expectedTargets();
  // Query public resolvers directly: the host's own resolver may serve a
  // stale or split-horizon answer, and a false positive here authorises
  // certificate issuance.
  const resolver = new Resolver({ timeout: 5_000, tries: 2 });
  resolver.setServers(["1.1.1.1", "8.8.8.8"]);

  let verified = false;
  let error: string | null = null;

  try {
    const cnames = await resolver.resolveCname(domain.hostname).catch(() => [] as string[]);
    verified = cnames.some((c) => c.toLowerCase().replace(/\.$/, "") === targets.cname);

    if (!verified && targets.ips.length) {
      const a = await resolver.resolve4(domain.hostname).catch(() => [] as string[]);
      verified = a.some((ip) => targets.ips.includes(ip));
    }

    if (!verified) {
      error = `Does not resolve to ${targets.cname}${
        targets.ips.length ? ` or ${targets.ips.join(", ")}` : ""
      }`;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  await withPlatform(async (tx) => {
    await tx
      .update(domains)
      .set({
        verifiedAt: verified ? new Date() : null,
        lastCheckedAt: new Date(),
        lastCheckError: error,
      })
      .where(eq(domains.id, domainId));
  });

  if (verified) {
    // Pass the tenant too: verifying a domain can change which hostname
    // is canonical, and that cache is keyed by tenant rather than host.
    await invalidateHostCache([domain.hostname], tenantId);
    await withTenant(tenantId, async (tx) => {
      await recordAudit(tx, tenantId, {
        actorType: "system",
        action: "domain.verified",
        entityType: "domain",
        entityId: domainId,
        after: { hostname: domain.hostname },
      });
    });
  }

  return { verified };
}
