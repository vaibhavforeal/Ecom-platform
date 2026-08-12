import Link from "next/link";
import { redirect } from "next/navigation";

import { can } from "@platform/core";
import { listMediaForConsole, listTaxonomyForConsole } from "@platform/core/catalog/server";

import { mediaUrl } from "../../../lib/media-url";
import { blankProduct, toMediaOption } from "../../../lib/product-form-state";
import { requireActor } from "../../../lib/session";
import { ProductForm } from "../ProductForm";

export const dynamic = "force-dynamic";

export default async function NewProductPage() {
  const actor = await requireActor();
  // The route handler checks this too — that is the one that matters.
  // This only avoids rendering a form that cannot be submitted.
  if (!can(actor, "catalog:write")) redirect("/products");

  const [taxonomy, library] = await Promise.all([
    listTaxonomyForConsole(actor.tenantId),
    listMediaForConsole(actor.tenantId),
  ]);

  return (
    <main>
      <nav className="crumbs">
        <Link href="/products">Products</Link> · New
      </nav>
      <h1>New product</h1>

      <ProductForm
        mode="create"
        initial={blankProduct()}
        categories={taxonomy.categories}
        collections={taxonomy.collections}
        library={library.map((m) => toMediaOption(m, mediaUrl(m.storageKey)))}
        historicalSlugs={[]}
        canWrite
      />
    </main>
  );
}
