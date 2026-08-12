import Link from "next/link";

import { discountPercent, formatPaise } from "@platform/core/catalog";
import type { ProductCard } from "@platform/core/catalog/server";

import { SIZES, mediaUrl, srcSetFor } from "../lib/media";
import { paths } from "../lib/urls";

/**
 * Product listing.
 *
 * Every image carries explicit width and height. Without them the
 * browser reserves no space, the layout jumps when each image lands, and
 * the page fails the CLS half of Core Web Vitals — which blueprint §6.2
 * makes a build gate, because it cannot be retrofitted in CSS.
 */

export function ProductCardTile({
  product,
  priority,
}: {
  product: ProductCard;
  priority: boolean;
}) {
  const discount = discountPercent(product.pricePaise, product.compareAtPaise);

  return (
    <li className="card">
      <Link href={paths.entity(product.slug)} className="card-link">
        {/*
          `src` stays the ORIGINAL and is what renders whenever the
          derivative set is missing — media is `pending` until the worker
          finishes, and `failed` media never gets derivatives at all.
          `srcSetFor` returns null rather than "" for those, and null
          becomes undefined here so React omits the attribute entirely:
          an EMPTY srcset makes some browsers fetch nothing, which is a
          blank card rather than a slow one.
        */}
        <div className="card-media">
          {product.imageStorageKey ? (
            <img
              src={mediaUrl(product.imageStorageKey)}
              srcSet={srcSetFor(product.imageDerivatives, "webp") ?? undefined}
              sizes={SIZES.card}
              alt={product.imageAlt ?? product.title}
              width={product.imageWidth ?? 600}
              height={product.imageHeight ?? 600}
              // The first row is the LCP candidate: it must not be lazy,
              // and it should be fetched ahead of the rest.
              loading={priority ? "eager" : "lazy"}
              fetchPriority={priority ? "high" : "auto"}
              decoding="async"
            />
          ) : (
            <div className="card-media-empty" aria-hidden="true" />
          )}
        </div>

        <h3 className="card-title">{product.title}</h3>

        <p className="card-price">
          <span className="price">{formatPaise(product.pricePaise, { currency: product.currency })}</span>
          {discount !== null && product.compareAtPaise !== null && (
            <>
              <s className="compare-at">
                {formatPaise(product.compareAtPaise, { currency: product.currency })}
              </s>
              <span className="discount">{discount}% off</span>
            </>
          )}
        </p>
      </Link>
    </li>
  );
}

export function ProductGrid({ products }: { products: ProductCard[] }) {
  if (products.length === 0) {
    return <p className="muted">Nothing here yet.</p>;
  }

  return (
    <ul className="grid">
      {products.map((product, i) => (
        // Only the first row is treated as above the fold. Marking every
        // image priority is the same as marking none.
        <ProductCardTile key={product.id} product={product} priority={i < 3} />
      ))}
    </ul>
  );
}
