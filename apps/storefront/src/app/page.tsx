import Link from "next/link";

import { storeSettings, withTenant } from "@platform/db";

import { JsonLd } from "../components/JsonLd";
import { ProductGrid } from "../components/ProductGrid";
import { getCachedCategories, getCachedProducts } from "../lib/catalog";
import { organizationJsonLd, websiteJsonLd } from "../lib/seo";
import { getOrigin, paths } from "../lib/urls";
import { requireTenant } from "../lib/tenant";

/**
 * Rendered per request, never statically.
 *
 * Next's full-route cache is keyed by PATHNAME and does not include the
 * Host header, so a statically generated /white-shirt would be served to
 * every tenant that has one. Edge caching is Cloudflare's job (it keys on
 * host + path); this app resolves the tenant on every request.
 */
export const dynamic = "force-dynamic";


export default async function HomePage() {
  const tenant = await requireTenant();
  const origin = await getOrigin(tenant.tenantId);

  const [settings, categories, latest] = await Promise.all([
    withTenant(tenant.tenantId, async (tx) => tx.select().from(storeSettings)),
    getCachedCategories(tenant.tenantId),
    getCachedProducts(tenant.tenantId, { limit: 12 }),
  ]);

  const tagline = settings.find((s) => s.key === "storefront.tagline")?.value;
  const roots = categories.filter((c) => c.parentId === null);

  return (
    <main>
      <JsonLd
        data={[
          organizationJsonLd({ name: tenant.displayName, url: origin }),
          websiteJsonLd({ name: tenant.displayName, url: origin }),
        ]}
      />

      <h1>{tenant.displayName}</h1>
      {typeof tagline === "string" && <p className="tagline">{tagline}</p>}

      {roots.length > 0 && (
        <nav aria-label="Categories">
          <ul className="chips">
            {roots.map((c) => (
              <li key={c.id}>
                <Link href={paths.entity(c.slug)} className="chip">
                  {c.title}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      )}

      <h2>Latest</h2>
      <ProductGrid products={latest.items} />
    </main>
  );
}
