import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@platform/core";
import {
  getProductForConsole,
  listMediaForConsole,
  listTaxonomyForConsole,
} from "@platform/core/catalog/server";
import { getStockLevels } from "@platform/core/inventory/server";
import { withTenant } from "@platform/db";

import { mediaUrl } from "../../../lib/media-url";
import { toFormState, toMediaOption } from "../../../lib/product-form-state";
import { requireActor } from "../../../lib/session";
import { AdjustStock } from "../../inventory/AdjustStock";
import { ProductForm } from "../ProductForm";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requireActor();
  const { id } = await params;

  // Shape-checked before it reaches a query: an id that is not a uuid
  // would otherwise come back as an opaque cast error rather than a 404.
  if (!UUID_RE.test(id)) notFound();

  if (!can(actor, "catalog:read")) {
    return (
      <main>
        <h1>Product</h1>
        <p className="error">Your role does not include access to the catalog.</p>
      </main>
    );
  }

  const [product, taxonomy, library] = await Promise.all([
    getProductForConsole(actor.tenantId, id),
    listTaxonomyForConsole(actor.tenantId),
    listMediaForConsole(actor.tenantId),
  ]);

  // Another merchant's product is invisible under this tenant's RLS
  // context, so a cross-tenant id lands here as a plain 404.
  if (!product) notFound();

  const trackedVariants = product.variants.filter((v) => v.tracksInventory);
  const levels =
    trackedVariants.length > 0
      ? await withTenant(actor.tenantId, (tx) =>
          getStockLevels(tx, trackedVariants.map((v) => v.id)),
        )
      : new Map<string, number>();

  // The gallery's own images may be older than the 60 most recent
  // uploads the picker offers, so the two lists are merged rather than
  // assumed to overlap — otherwise an attached image renders as a blank
  // thumbnail with no alt field.
  const known = new Map(library.map((m) => [m.id, m]));
  for (const item of product.media) known.set(item.id, item);

  return (
    <main>
      <nav className="crumbs">
        <Link href="/products">Products</Link> · {product.title}
      </nav>
      <h1>{product.title}</h1>
      <p className="muted">
        {product.slug ? <code>/{product.slug}</code> : "No URL"} · {product.status}
      </p>

      <ProductForm
        mode="edit"
        productId={product.id}
        initial={toFormState(product)}
        categories={taxonomy.categories}
        collections={taxonomy.collections}
        library={[...known.values()].map((m) => toMediaOption(m, mediaUrl(m.storageKey)))}
        historicalSlugs={product.historicalSlugs}
        canWrite={can(actor, "catalog:write")}
      />

      {trackedVariants.length > 0 && can(actor, "inventory:read") && (
        <div className="panel">
          <h2 className="section">Inventory</h2>
          <table className="grid">
            <thead>
              <tr>
                <th>SKU</th>
                <th style={{ textAlign: "right" }}>On hand</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {trackedVariants.map((v) => (
                <tr key={v.id}>
                  <td>
                    <code>{v.sku}</code>
                  </td>
                  <td style={{ textAlign: "right" }}>{levels.get(v.id) ?? 0}</td>
                  <td style={{ textAlign: "right" }}>
                    <AdjustStock
                      variantId={v.id}
                      sku={v.sku}
                      onHand={levels.get(v.id) ?? 0}
                      canWrite={can(actor, "inventory:write")}
                    />{" "}
                    <Link href={`/inventory/${v.id}`} className="chip">
                      History
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            A newly tracked variant starts at zero — record its opening balance here before it
            reads as out of stock on the storefront.
          </p>
        </div>
      )}
    </main>
  );
}
