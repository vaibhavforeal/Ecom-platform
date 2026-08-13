import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";

import {
  buildCategoryTree,
  categoryPath,
  subtreeIds,
} from "@platform/core/catalog";
import type { CategorySummary, ProductDetail } from "@platform/core/catalog/server";

import { JsonLd } from "../../components/JsonLd";
import { ProductGrid } from "../../components/ProductGrid";
import { VariantPicker } from "../../components/VariantPicker";
import {
  getCachedCategories,
  getCachedCollection,
  getCachedProduct,
  getCachedProducts,
  getCachedSlugResolution,
} from "../../lib/catalog";
import { SIZES, mediaUrl, srcSetFor } from "../../lib/media";
import {
  breadcrumbJsonLd,
  imageUrlsFor,
  metaDescription,
  plainText,
  productJsonLd,
  readSeoOverrides,
} from "../../lib/seo";
import { getOrigin, paths } from "../../lib/urls";
import { requireTenant } from "../../lib/tenant";

/**
 * Rendered per request, never statically.
 *
 * Next's full-route cache is keyed by PATHNAME and does not include the
 * Host header, so a statically generated /white-shirt would be served to
 * every tenant that has one. Edge caching is Cloudflare's job (it keys on
 * host + path); this app resolves the tenant on every request.
 */
export const dynamic = "force-dynamic";


/**
 * Every public catalog URL.
 *
 * One route rather than /products/x and /categories/y, because
 * `url_slugs` is keyed per tenant across all entity types — a slug can
 * only ever mean one thing, so the path does not need a discriminator.
 * Shorter URLs also survive being pasted into WhatsApp, which is how
 * most Indian storefront links actually travel.
 *
 * Static sibling routes (/search, /sitemap.xml) take precedence over
 * this dynamic segment in Next's matcher, and `RESERVED_SLUGS` in
 * @platform/core keeps a merchant from ever being assigned one of them.
 */

type Params = { params: Promise<{ slug: string }> };
type Search = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * Resolves the slug once per request.
 *
 * `generateMetadata` and the page body both need this, and Next calls
 * them separately. The per-request memoisation in `requireTenant` plus
 * the tagged data cache in lib/catalog mean the second call is free
 * rather than a second round of queries.
 */
async function load(slug: string) {
  const tenant = await requireTenant();
  const resolution = await getCachedSlugResolution(tenant.tenantId, decodeURIComponent(slug));
  return { tenant, resolution };
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const { tenant, resolution } = await load(slug);

  if (resolution.action !== "render") return { title: "Not found" };

  const origin = await getOrigin(tenant.tenantId);
  const canonical = `${origin}${paths.entity(decodeURIComponent(slug))}`;

  if (resolution.entityType === "product") {
    const product = await getCachedProduct(tenant.tenantId, resolution.entityId);
    if (!product) return { title: "Not found" };

    const seo = readSeoOverrides(product.seo);
    const description = metaDescription(seo.description, product.summary, product.description);

    return {
      title: seo.title ?? product.title,
      description,
      alternates: { canonical },
      robots: seo.noindex ? { index: false, follow: true } : undefined,
      openGraph: {
        type: "website",
        title: seo.title ?? product.title,
        description,
        url: canonical,
        images: imageUrlsFor(product.images, origin),
      },
    };
  }

  if (resolution.entityType === "category") {
    const categories = await getCachedCategories(tenant.tenantId);
    const category = categories.find((c) => c.id === resolution.entityId);
    if (!category) return { title: "Not found" };

    const seo = readSeoOverrides(category.seo);
    return {
      title: seo.title ?? category.title,
      description: metaDescription(seo.description, category.description),
      alternates: { canonical },
      robots: seo.noindex ? { index: false, follow: true } : undefined,
    };
  }

  const collection = await getCachedCollection(tenant.tenantId, resolution.entityId);
  if (!collection) return { title: "Not found" };

  const seo = readSeoOverrides(collection.seo);
  return {
    title: seo.title ?? collection.title,
    description: metaDescription(seo.description, collection.description),
    alternates: { canonical },
    robots: seo.noindex ? { index: false, follow: true } : undefined,
  };
}

export default async function EntityPage({ params, searchParams }: Params & Search) {
  const { slug } = await params;
  const decoded = decodeURIComponent(slug);
  const { tenant, resolution } = await load(slug);

  // A renamed product keeps its old URL working. 301 rather than 302:
  // a temporary redirect never transfers the ranking signal, which is
  // the entire reason slug history exists.
  if (resolution.action === "redirect") permanentRedirect(paths.entity(resolution.to));
  if (resolution.action === "notFound") notFound();

  const origin = await getOrigin(tenant.tenantId);

  if (resolution.entityType === "product") {
    const product = await getCachedProduct(tenant.tenantId, resolution.entityId);
    if (!product) notFound();
    return (
      <ProductView
        product={product}
        organizationName={tenant.displayName}
        origin={origin}
        slug={decoded}
      />
    );
  }

  const page = readPage(await searchParams);

  if (resolution.entityType === "category") {
    const categories = await getCachedCategories(tenant.tenantId);
    const category = categories.find((c) => c.id === resolution.entityId);
    if (!category) notFound();

    // Products filed under a child category still belong on the parent's
    // page — a shopper browsing "Apparel" expects to see what is under
    // "Apparel > Shirts", not an empty listing.
    const ids = subtreeIds(categories, category.id);
    const { items, total } = await getCachedProducts(tenant.tenantId, {
      categoryIds: ids,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    });

    const trail = categoryPath(categories, category.id);

    return (
      <main>
        <JsonLd
          data={breadcrumbJsonLd([
            { name: tenant.displayName, url: `${origin}/` },
            ...trail.map((c) => ({ name: c.title, url: `${origin}${paths.entity(c.slug)}` })),
          ])}
        />

        <Breadcrumbs tenantName={tenant.displayName} trail={trail} />

        <h1>{category.title}</h1>
        {category.description && <p className="tagline">{plainText(category.description, 300)}</p>}

        <Subcategories categories={categories} parentId={category.id} />

        <ProductGrid products={items} />
        <Pagination total={total} page={page} slug={decoded} />
      </main>
    );
  }

  const collection = await getCachedCollection(tenant.tenantId, resolution.entityId);
  if (!collection) notFound();

  const { items, total } = await getCachedProducts(tenant.tenantId, {
    collectionId: collection.id,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  });

  return (
    <main>
      <JsonLd
        data={breadcrumbJsonLd([
          { name: tenant.displayName, url: `${origin}/` },
          { name: collection.title, url: `${origin}${paths.entity(collection.slug)}` },
        ])}
      />

      <h1>{collection.title}</h1>
      {collection.description && (
        <p className="tagline">{plainText(collection.description, 300)}</p>
      )}

      <ProductGrid products={items} />
      <Pagination total={total} page={page} slug={decoded} />
    </main>
  );
}

const PAGE_SIZE = 24;

function readPage(searchParams: Record<string, string | string[] | undefined>): number {
  const raw = Array.isArray(searchParams.page) ? searchParams.page[0] : searchParams.page;
  const parsed = Number.parseInt(raw ?? "1", 10);
  return Number.isFinite(parsed) && parsed > 1 ? parsed - 1 : 0;
}

function Breadcrumbs({
  tenantName,
  trail,
}: {
  tenantName: string;
  trail: CategorySummary[];
}) {
  return (
    <nav aria-label="Breadcrumb" className="breadcrumbs">
      <Link href={paths.home()}>{tenantName}</Link>
      {trail.map((c) => (
        <span key={c.id}>
          {" / "}
          <Link href={paths.entity(c.slug)}>{c.title}</Link>
        </span>
      ))}
    </nav>
  );
}

function Subcategories({
  categories,
  parentId,
}: {
  categories: CategorySummary[];
  parentId: string;
}) {
  const children = buildCategoryTree(categories).flatMap(function find(node): CategorySummary[] {
    if (node.id === parentId) return node.children;
    return node.children.flatMap(find);
  });

  if (children.length === 0) return null;

  return (
    <ul className="chips">
      {children.map((c) => (
        <li key={c.id}>
          <Link href={paths.entity(c.slug)} className="chip">
            {c.title}
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Pagination({ total, page, slug }: { total: number; page: number; slug: string }) {
  const pages = Math.ceil(total / PAGE_SIZE);
  if (pages <= 1) return null;

  return (
    <nav className="pagination" aria-label="Pagination">
      {page > 0 && (
        <Link href={`${paths.entity(slug)}${page > 1 ? `?page=${page}` : ""}`} rel="prev">
          ← Previous
        </Link>
      )}
      <span className="muted">
        Page {page + 1} of {pages}
      </span>
      {page + 1 < pages && (
        <Link href={`${paths.entity(slug)}?page=${page + 2}`} rel="next">
          Next →
        </Link>
      )}
    </nav>
  );
}

function ProductView({
  product,
  organizationName,
  origin,
  slug,
}: {
  product: ProductDetail;
  organizationName: string;
  origin: string;
  slug: string;
}) {
  const url = `${origin}${paths.entity(slug)}`;
  const hero = product.images[0];

  return (
    <main>
      <JsonLd
        data={[
          productJsonLd({
            product,
            url,
            organizationName,
            imageUrls: imageUrlsFor(product.images, origin),
          }),
          breadcrumbJsonLd([
            { name: organizationName, url: `${origin}/` },
            { name: product.title, url },
          ]),
        ]}
      />

      <article className="pdp">
        {hero && (
          <img
            className="pdp-hero"
            src={mediaUrl(hero.storageKey)}
            srcSet={srcSetFor(hero.derivatives, "webp") ?? undefined}
            sizes={SIZES.hero}
            alt={hero.alt ?? product.title}
            width={hero.width ?? 1200}
            height={hero.height ?? 1200}
            // The LCP element on this page. Never lazy.
            loading="eager"
            fetchPriority="high"
            decoding="async"
          />
        )}

        <h1>{product.title}</h1>
        {product.summary && <p className="tagline">{product.summary}</p>}

        <VariantPicker axes={product.axes} variants={product.variants} />

        {/* Sanitised at the cache fill in lib/catalog.ts — never render a
            description that has not passed through getCachedProduct. */}
        {product.description && (
          <div className="prose" dangerouslySetInnerHTML={{ __html: product.description }} />
        )}
      </article>
    </main>
  );
}
