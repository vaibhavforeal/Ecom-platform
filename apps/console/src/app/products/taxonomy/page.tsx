import Link from "next/link";

import { can } from "@platform/core";
import { listTaxonomyForConsole } from "@platform/core/catalog/server";

import { requireActor } from "../../../lib/session";
import { TaxonomyEditor } from "./TaxonomyEditor";

export const dynamic = "force-dynamic";

export default async function TaxonomyPage() {
  const actor = await requireActor();

  if (!can(actor, "catalog:read")) {
    return (
      <main>
        <h1>Categories and collections</h1>
        <p className="error">Your role does not include access to the catalog.</p>
      </main>
    );
  }

  const taxonomy = await listTaxonomyForConsole(actor.tenantId);
  const canWrite = can(actor, "catalog:write");

  return (
    <main>
      <nav className="crumbs">
        <Link href="/products">Products</Link> · Categories
      </nav>
      <h1>Categories and collections</h1>
      <p className="muted">
        Both own a public URL, so both keep their old ones redirecting when renamed.
      </p>

      <TaxonomyEditor kind="categories" rows={taxonomy.categories} canWrite={canWrite} />
      <TaxonomyEditor kind="collections" rows={taxonomy.collections} canWrite={canWrite} />
    </main>
  );
}
