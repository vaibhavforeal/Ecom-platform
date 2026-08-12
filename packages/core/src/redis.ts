import Redis from "ioredis";

let client: Redis | undefined;

export function redis(): Redis {
  if (!client) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is not set");
    client = new Redis(url, {
      maxRetriesPerRequest: null, // required by BullMQ
      enableReadyCheck: true,
    });
  }
  return client;
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit();
    client = undefined;
  }
}

/**
 * Tenant-prefixed cache keys.
 *
 * Every cache key in the system goes through here. An unprefixed key is
 * a cross-tenant data leak that RLS cannot catch, because Redis has no
 * idea what a tenant is — this helper is the only thing standing between
 * `product:shoes` and one merchant serving another's catalog.
 *
 * See PLATFORM_BLUEPRINT.md §2.5.
 */
export function tenantKey(tenantId: string, ...parts: (string | number)[]): string {
  if (!tenantId) throw new Error("tenantKey requires a tenantId");
  return ["t", tenantId, ...parts].join(":");
}

/** Keys for genuinely global data (hostname → tenant, OTP rate limits). */
export function platformKey(...parts: (string | number)[]): string {
  return ["p", ...parts].join(":");
}
