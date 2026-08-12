import Link from "next/link";
import { redirect } from "next/navigation";

import { can } from "@platform/core";
import { MAX_IMPORT_ROWS, REQUIRED_CSV_COLUMNS } from "@platform/core/catalog";

import { requireActor } from "../../../lib/session";
import { ImportPanel } from "./ImportPanel";

export const dynamic = "force-dynamic";

/**
 * Bulk import and export.
 *
 * The export is a plain link — a GET that streams, so the browser's own
 * download machinery handles it and a merchant on a slow connection sees
 * progress rather than a spinner. The import needs state (choose a file,
 * preview, then confirm) and lives in the client component below.
 */
export default async function ImportPage() {
  const actor = await requireActor();
  if (!can(actor, "catalog:read")) redirect("/products");

  const canWrite = can(actor, "catalog:write");

  return (
    <main>
      <nav className="crumbs">
        <Link href="/products">Products</Link> · Import and export
      </nav>

      <h1>Import and export</h1>

      <div className="panel">
        <h2>Export</h2>
        <p className="muted">
          Every product you have, drafts and archived ones included, one row per variant.
          Prices are in rupees.
        </p>
        <p>
          <a className="chip" href="/api/products/export" download>
            Download catalog CSV
          </a>
        </p>
      </div>

      {canWrite ? (
        <ImportPanel />
      ) : (
        <div className="panel">
          <h2>Import</h2>
          <p className="error">Your role does not include changing the catalog.</p>
        </div>
      )}

      <div className="panel">
        <h2>What the file needs</h2>
        <p className="muted">
          One row per variant. The <code>handle</code> column groups a product&rsquo;s variant
          rows and is also its web address, so repeat it on every row of the same product.
        </p>
        <p className="muted">
          Required columns: {REQUIRED_CSV_COLUMNS.map((c) => <code key={c}>{c} </code>)}
        </p>
        <ul className="muted">
          <li>
            A column you leave out of the file is left alone in the catalog. A column you
            include but leave blank is cleared.
          </li>
          <li>
            A variant that is <em>not</em> in the file is kept, not deleted. Remove variants
            from the product page instead.
          </li>
          <li>
            A handle that matches an existing product&rsquo;s address updates it. Anything
            else creates a new product. If that address is already taken — including by a
            product that has since been renamed away from it — the new product gets a
            numbered one, and the preview says so.
          </li>
          <li>At most {MAX_IMPORT_ROWS} rows per file.</li>
          <li>
            Format the SKU and barcode columns as <strong>text</strong> before you save.
            A spreadsheet turns <code>0012</code> into <code>12</code> and a long barcode
            into <code>9.78031E+12</code>, and neither can be undone afterwards.
          </li>
        </ul>
      </div>
    </main>
  );
}
