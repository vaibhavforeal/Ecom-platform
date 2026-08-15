"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { ALLOWED_DESCRIPTION_TAGS, cartesianCombinations } from "@platform/core/catalog";

import {
  blankVariant,
  formKey,
  mediaStatusFrom,
  parseAxisValues,
  parseTags,
  rebuildMatrix,
} from "../../lib/product-form-state";
import type {
  MediaOption,
  ProductFormState,
  TaxonomyOption,
  VariantFormRow,
} from "../../lib/product-form-state";

/**
 * The product editor.
 *
 * A client component because the option matrix is interactive: declaring
 * a Size axis has to produce variant rows immediately, and the merchant
 * has to be able to see what they will get before saving. It posts JSON
 * to the route handlers rather than using a Server Action, matching what
 * the console already does everywhere else — login, media upload — so
 * there is one style of mutation in this app rather than two.
 *
 * Nothing here is a security boundary. Every rule this form applies is
 * applied again by zod at the route and again by the write layer; this
 * is only about telling a merchant what is wrong before they wait for a
 * round trip.
 */

type Issue = { path: string; message: string };

type Props = {
  mode: "create" | "edit";
  productId?: string;
  initial: ProductFormState;
  categories: TaxonomyOption[];
  collections: TaxonomyOption[];
  library: MediaOption[];
  /** Superseded URLs. These still permanently redirect. */
  historicalSlugs: string[];
  canWrite: boolean;
};

const STATUSES = ["draft", "active", "archived"] as const;

export function ProductForm({
  mode,
  productId,
  initial,
  categories,
  collections,
  library: initialLibrary,
  historicalSlugs,
  canWrite,
}: Props) {
  const router = useRouter();
  const [form, setForm] = useState<ProductFormState>(initial);
  const [library, setLibrary] = useState<MediaOption[]>(initialLibrary);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);

  function set<K extends keyof ProductFormState>(key: K, value: ProductFormState[K]): void {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function issuesFor(prefix: string): Issue[] {
    return issues.filter((i) => i.path === prefix || i.path.startsWith(`${prefix}.`));
  }

  // ── Options and the variant matrix ──

  function applyMatrix(): void {
    const axes = form.axes
      .map((a) => ({ name: a.name.trim(), values: parseAxisValues(a.values) }))
      .filter((a) => a.name !== "" && a.values.length > 0);

    setForm((f) => ({ ...f, variants: rebuildMatrix(cartesianCombinations(axes), f.variants) }));
  }

  function updateVariant(key: string, patch: Partial<VariantFormRow>): void {
    setForm((f) => ({
      ...f,
      variants: f.variants.map((v) => (v.key === key ? { ...v, ...patch } : v)),
    }));
  }

  // ── Description ──

  /**
   * Wraps the selection in a tag, or inserts an empty pair at the caret.
   *
   * The console's "rich text" is a textarea plus this — deliberately.
   * Every tag it can produce is on the sanitiser's allowlist, so what a
   * merchant builds here is exactly what survives the save, rather than
   * a WYSIWYG that silently loses half of what it let them do.
   */
  function wrapSelection(tag: string): void {
    const el = descriptionRef.current;
    if (!el) return;

    const start = el.selectionStart;
    const end = el.selectionEnd;
    const value = el.value;
    const selected = value.slice(start, end);
    const next = `${value.slice(0, start)}<${tag}>${selected}</${tag}>${value.slice(end)}`;

    set("description", next);
    // Put the caret between the tags so typing continues inside them.
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + tag.length + 2;
      el.setSelectionRange(caret, caret + selected.length);
    });
  }

  // ── Media ──

  function attach(option: MediaOption): void {
    setForm((f) =>
      f.media.some((m) => m.mediaId === option.id)
        ? f
        : { ...f, media: [...f.media, { mediaId: option.id, alt: option.alt }] },
    );
  }

  function detach(mediaId: string): void {
    setForm((f) => ({
      ...f,
      media: f.media.filter((m) => m.mediaId !== mediaId),
      // A variant pointing at an image no longer in the gallery would
      // render nothing on the PDP; clear it rather than leave it dangling.
      variants: f.variants.map((v) =>
        v.imageMediaId === mediaId ? { ...v, imageMediaId: "" } : v,
      ),
    }));
  }

  function move(mediaId: string, delta: number): void {
    setForm((f) => {
      const index = f.media.findIndex((m) => m.mediaId === mediaId);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= f.media.length) return f;
      const next = [...f.media];
      const [item] = next.splice(index, 1);
      if (item) next.splice(target, 0, item);
      return { ...f, media: next };
    });
  }

  async function upload(file: File): Promise<void> {
    setBusy(true);
    setIssues([]);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/media/upload", { method: "POST", body });
      const data = (await res.json()) as {
        mediaId?: string;
        status?: string;
        alt?: string | null;
        error?: { message?: string };
      };

      if (!res.ok || !data.mediaId) {
        setIssues([{ path: "media", message: data.error?.message ?? "That image was refused." }]);
        return;
      }

      // The upload response carries no storage key — the worker has not
      // written the derivatives yet. The row is real, so it can be
      // attached now; the thumbnail appears on the next page load.
      //
      // `alt` comes from the response and is null unless the upload
      // deduplicated onto an image that already had one. It must NOT be
      // "": `alt` lives on `media`, so saving a blank here would erase
      // the sentence on every product using the same photograph, and
      // the merchant would never have touched the box.
      const option: MediaOption = {
        id: data.mediaId,
        url: "",
        storageKey: "",
        alt: data.alt ?? null,
        status: mediaStatusFrom(data.status),
        processingError: null,
      };
      setLibrary((l) => (l.some((m) => m.id === option.id) ? l : [option, ...l]));
      attach(option);
    } finally {
      setBusy(false);
    }
  }

  // ── Save ──

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setIssues([]);
    setSaved(null);

    const payload = {
      title: form.title,
      slug: form.slug.trim() || null,
      summary: form.summary,
      description: form.description,
      status: form.status,
      productType: form.productType,
      vendor: form.vendor,
      tags: parseTags(form.tags),
      hsnCode: form.hsnCode,
      taxRatePercent: form.taxRatePercent.trim() || null,
      seo: {
        title: form.seoTitle.trim() || undefined,
        description: form.seoDescription.trim() || undefined,
        noindex: form.noindex,
      },
      axes: form.axes
        .map((a) => ({ name: a.name.trim(), values: parseAxisValues(a.values) }))
        .filter((a) => a.name !== ""),
      variants: form.variants.map((v) => ({
        id: v.id,
        sku: v.sku,
        barcode: v.barcode,
        options: v.options,
        price: v.price,
        compareAt: v.compareAt,
        cost: v.cost,
        // Send what the merchant typed, as a number. The server's z.int() is
        // the validator — parseInt here silently truncated "1.5" to 1, which
        // the server then accepted. Blank stays null so it is refused loudly
        // (a blank weight would otherwise quote shipping at zero).
        weightGrams: v.weightGrams.trim() === "" ? null : Number(v.weightGrams),
        lowStockAt: v.lowStockAt.trim() === "" ? null : Number(v.lowStockAt),
        imageMediaId: v.imageMediaId || null,
        tracksInventory: v.tracksInventory,
        isActive: v.isActive,
      })),
      categoryIds: form.categoryIds,
      collectionIds: form.collectionIds,
      media: form.media.map((m) => ({ mediaId: m.mediaId, alt: m.alt })),
    };

    try {
      const res = await fetch(mode === "create" ? "/api/products" : `/api/products/${productId}`, {
        method: mode === "create" ? "POST" : "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = (await res.json()) as {
        productId?: string;
        slug?: string;
        previousSlug?: string | null;
        error?: { message?: string; details?: { issues?: Issue[] } };
      };

      if (!res.ok) {
        setIssues(
          data.error?.details?.issues ?? [
            { path: "form", message: data.error?.message ?? "That could not be saved." },
          ],
        );
        return;
      }

      if (mode === "create" && data.productId) {
        router.push(`/products/${data.productId}`);
        return;
      }

      setSaved(
        data.previousSlug
          ? `Saved. /${data.previousSlug} now redirects to /${data.slug}.`
          : "Saved.",
      );
      router.refresh();
    } catch {
      setIssues([{ path: "form", message: "The console could not reach the server." }]);
    } finally {
      setBusy(false);
    }
  }

  const generalIssues = issues.filter(
    (i) => !i.path.startsWith("variants") && !i.path.startsWith("axes"),
  );

  return (
    <form onSubmit={save}>
      <div className="panel">
        <h2 className="section">Basics</h2>

        <label htmlFor="title">Title</label>
        <input
          id="title"
          value={form.title}
          onChange={(e) => set("title", e.target.value)}
          maxLength={200}
          required
        />
        <FieldIssues issues={issuesFor("title")} />

        <label htmlFor="slug" style={{ marginTop: 14 }}>
          URL
        </label>
        <input
          id="slug"
          value={form.slug}
          onChange={(e) => set("slug", e.target.value)}
          placeholder="derived from the title"
          maxLength={96}
        />
        <p className="muted">
          Changing this keeps the old URL working — it is recorded and permanently redirected, so
          nothing that already links to this product breaks.
        </p>
        {historicalSlugs.length > 0 && (
          <p className="muted">
            Redirecting here:{" "}
            {historicalSlugs.map((s) => (
              <code key={s} style={{ marginRight: 8 }}>
                /{s}
              </code>
            ))}
          </p>
        )}
        <FieldIssues issues={issuesFor("slug")} />

        <label htmlFor="status" style={{ marginTop: 14 }}>
          Status
        </label>
        <select
          id="status"
          value={form.status}
          onChange={(e) => set("status", e.target.value as ProductFormState["status"])}
        >
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <p className="muted">Only an active product appears on the storefront.</p>

        <label htmlFor="summary" style={{ marginTop: 14 }}>
          Summary
        </label>
        <input
          id="summary"
          value={form.summary}
          onChange={(e) => set("summary", e.target.value)}
          maxLength={500}
          placeholder="One line for cards and search results"
        />
      </div>

      <div className="panel">
        <h2 className="section">Description</h2>

        <div className="toolbar">
          {(["strong", "em", "u", "h2", "h3", "p", "ul", "li", "blockquote"] as const).map((tag) => (
            <button key={tag} type="button" className="chip" onClick={() => wrapSelection(tag)}>
              {tag}
            </button>
          ))}
        </div>

        <textarea
          id="description"
          ref={descriptionRef}
          value={form.description}
          onChange={(e) => set("description", e.target.value)}
          rows={10}
          maxLength={60_000}
        />
        <p className="muted">
          Formatting is kept for {ALLOWED_DESCRIPTION_TAGS.join(", ")}. Anything else — scripts,
          styles, images, event handlers — is stripped when you save, and links are limited to
          http, https and mailto addresses. That is not a preference; it is what stops one
          merchant&apos;s description running code in another customer&apos;s browser.
        </p>
        <FieldIssues issues={issuesFor("description")} />
      </div>

      <div className="panel">
        <h2 className="section">Options</h2>
        <p className="muted">
          Declare the axes a customer chooses from — Size, Colour. Leave this empty for a product
          that comes only one way.
        </p>

        {form.axes.map((axis, index) => (
          <div key={axis.key} className="row" style={{ marginTop: 12 }}>
            <div style={{ width: 160 }}>
              <label htmlFor={`axis-name-${axis.key}`}>Name</label>
              <input
                id={`axis-name-${axis.key}`}
                value={axis.name}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    axes: f.axes.map((a, i) =>
                      i === index ? { ...a, name: e.target.value } : a,
                    ),
                  }))
                }
                maxLength={40}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label htmlFor={`axis-values-${axis.key}`}>Values, comma separated</label>
              <input
                id={`axis-values-${axis.key}`}
                value={axis.values}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    axes: f.axes.map((a, i) =>
                      i === index ? { ...a, values: e.target.value } : a,
                    ),
                  }))
                }
                placeholder="S, M, L"
              />
            </div>
            <button
              type="button"
              className="chip"
              onClick={() =>
                setForm((f) => ({ ...f, axes: f.axes.filter((_, i) => i !== index) }))
              }
            >
              Remove
            </button>
          </div>
        ))}

        <div className="toolbar" style={{ marginTop: 14 }}>
          <button
            type="button"
            className="chip"
            disabled={form.axes.length >= 3}
            onClick={() =>
              setForm((f) => ({
                ...f,
                axes: [...f.axes, { key: formKey("a"), name: "", values: "" }],
              }))
            }
          >
            Add option
          </button>
          <button type="button" className="chip" onClick={applyMatrix}>
            Rebuild variants from options
          </button>
        </div>
        <p className="muted">
          Rebuilding keeps the SKU and price already typed against each combination, and drops the
          rows whose combination no longer exists.
        </p>
        <FieldIssues issues={issuesFor("axes")} />
      </div>

      <div className="panel">
        <h2 className="section">Variants</h2>

        <table className="grid">
          <thead>
            <tr>
              <th>Combination</th>
              <th>SKU</th>
              <th>Price ₹</th>
              <th>Was ₹</th>
              <th>Weight g</th>
              <th>Image</th>
              <th>Tracked</th>
              <th>Live</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {form.variants.map((variant, index) => (
              <tr key={variant.key}>
                <td className="muted">
                  {Object.keys(variant.options).length === 0
                    ? "—"
                    : Object.entries(variant.options)
                        .map(([name, value]) => `${name}: ${value}`)
                        .join(" · ")}
                  <FieldIssues issues={issuesFor(`variants.${index}`)} />
                </td>
                <td>
                  <input
                    aria-label={`SKU for variant ${index + 1}`}
                    value={variant.sku}
                    onChange={(e) => updateVariant(variant.key, { sku: e.target.value })}
                    maxLength={64}
                  />
                </td>
                <td>
                  <input
                    aria-label={`Price for variant ${index + 1}`}
                    value={variant.price}
                    onChange={(e) => updateVariant(variant.key, { price: e.target.value })}
                    inputMode="decimal"
                  />
                </td>
                <td>
                  <input
                    aria-label={`Compare-at price for variant ${index + 1}`}
                    value={variant.compareAt}
                    onChange={(e) => updateVariant(variant.key, { compareAt: e.target.value })}
                    inputMode="decimal"
                  />
                </td>
                <td>
                  <input
                    aria-label={`Weight in grams for variant ${index + 1}`}
                    value={variant.weightGrams}
                    onChange={(e) => updateVariant(variant.key, { weightGrams: e.target.value })}
                    inputMode="numeric"
                  />
                </td>
                <td>
                  <select
                    aria-label={`Image for variant ${index + 1}`}
                    value={variant.imageMediaId}
                    onChange={(e) => updateVariant(variant.key, { imageMediaId: e.target.value })}
                  >
                    <option value="">—</option>
                    {form.media.map((m, i) => (
                      <option key={m.mediaId} value={m.mediaId}>
                        Image {i + 1}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Variant ${index + 1} tracks inventory`}
                    checked={variant.tracksInventory}
                    onChange={(e) =>
                      updateVariant(variant.key, { tracksInventory: e.target.checked })
                    }
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Variant ${index + 1} is for sale`}
                    checked={variant.isActive}
                    onChange={(e) => updateVariant(variant.key, { isActive: e.target.checked })}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="chip"
                    disabled={form.variants.length === 1}
                    onClick={() =>
                      setForm((f) => ({
                        ...f,
                        variants: f.variants.filter((v) => v.key !== variant.key),
                      }))
                    }
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <button
          type="button"
          className="chip"
          onClick={() => setForm((f) => ({ ...f, variants: [...f.variants, blankVariant()] }))}
        >
          Add variant
        </button>
        <p className="muted">
          Tracked variants carry a stock count in the ledger — manage quantities from the
          Inventory page or the panel below. A variant tracked at zero shows as out of stock
          on the storefront; untracked variants are always available.
        </p>
      </div>

      <div className="panel">
        <h2 className="section">Images</h2>

        {form.media.length === 0 && <p className="muted">No images attached.</p>}

        {form.media.map((item, index) => {
          const option = library.find((m) => m.id === item.mediaId);
          return (
            <div key={item.mediaId} className="row" style={{ marginTop: 12 }}>
              {option?.url ? (
                // A plain <img>, not next/image: these are previews of a
                // merchant's own upload at a fixed 64px, and routing them
                // through the optimiser would cost a server round trip
                // per thumbnail for no visual gain.
                <img src={option.url} alt="" className="thumb" />
              ) : (
                <span className="thumb thumb-empty" aria-hidden="true" />
              )}
              <div style={{ flex: 1 }}>
                <label htmlFor={`alt-${item.mediaId}`}>
                  Alt text {index === 0 && <>· this is the one the storefront leads with</>}
                </label>
                <input
                  id={`alt-${item.mediaId}`}
                  // Null means "nothing typed here"; the box shows blank
                  // and the save leaves the stored alt alone. Typing —
                  // including clearing the box, which yields "" — is
                  // what makes it a value the save writes.
                  value={item.alt ?? ""}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      media: f.media.map((m) =>
                        m.mediaId === item.mediaId ? { ...m, alt: e.target.value } : m,
                      ),
                    }))
                  }
                  maxLength={300}
                  placeholder="What is in the picture?"
                />
                {option?.status === "pending" && (
                  <p className="muted">
                    Still processing — the storefront will not show it until it is ready.
                  </p>
                )}
                {option?.status === "failed" && (
                  // `failed` is terminal for this row: nothing retries it
                  // on its own and there is no retry button. Uploading
                  // the same file again IS the retry — the upload route
                  // skips failed rows when it deduplicates, so the
                  // re-upload resets this row and re-queues it.
                  <p className="error">
                    Processing failed
                    {option.processingError ? `: ${option.processingError}` : ""}. Upload the same
                    file again to retry it — the storefront will not show it until it succeeds.
                  </p>
                )}
              </div>
              <div className="toolbar">
                <button type="button" className="chip" onClick={() => move(item.mediaId, -1)}>
                  ↑
                </button>
                <button type="button" className="chip" onClick={() => move(item.mediaId, 1)}>
                  ↓
                </button>
                <button type="button" className="chip" onClick={() => detach(item.mediaId)}>
                  Remove
                </button>
              </div>
            </div>
          );
        })}

        <label htmlFor="upload" style={{ marginTop: 18 }}>
          Upload an image
        </label>
        <input
          id="upload"
          type="file"
          accept="image/*"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void upload(file);
          }}
        />

        {library.length > 0 && (
          <>
            <p className="muted" style={{ marginTop: 18 }}>
              Or attach one already uploaded:
            </p>
            <div className="toolbar">
              {library
                .filter((m) => !form.media.some((a) => a.mediaId === m.id))
                .slice(0, 24)
                .map((m) => (
                  <button key={m.id} type="button" className="chip" onClick={() => attach(m)}>
                    {m.storageKey ? m.storageKey.split("/").pop() : m.id.slice(0, 8)}
                    {m.status !== "ready" ? ` (${m.status})` : ""}
                  </button>
                ))}
            </div>
          </>
        )}
        <FieldIssues issues={issuesFor("media")} />
      </div>

      <div className="panel">
        <h2 className="section">Categories and collections</h2>

        <CheckboxList
          legend="Categories"
          options={categories}
          selected={form.categoryIds}
          onChange={(ids) => set("categoryIds", ids)}
          empty="No categories yet."
        />
        <FieldIssues issues={issuesFor("categoryIds")} />

        <CheckboxList
          legend="Collections"
          options={collections}
          selected={form.collectionIds}
          onChange={(ids) => set("collectionIds", ids)}
          empty="No collections yet."
        />
        <FieldIssues issues={issuesFor("collectionIds")} />
      </div>

      <details className="panel">
        <summary className="section">Tax, merchandising and SEO</summary>

        <label htmlFor="hsn" style={{ marginTop: 14 }}>
          HSN code
        </label>
        <input
          id="hsn"
          value={form.hsnCode}
          onChange={(e) => set("hsnCode", e.target.value)}
          maxLength={12}
        />

        <label htmlFor="tax" style={{ marginTop: 14 }}>
          GST rate %
        </label>
        <input
          id="tax"
          value={form.taxRatePercent}
          onChange={(e) => set("taxRatePercent", e.target.value)}
          inputMode="decimal"
          placeholder="5"
        />
        <FieldIssues issues={issuesFor("taxRatePercent")} />

        <label htmlFor="productType" style={{ marginTop: 14 }}>
          Product type
        </label>
        <input
          id="productType"
          value={form.productType}
          onChange={(e) => set("productType", e.target.value)}
          maxLength={80}
        />

        <label htmlFor="vendor" style={{ marginTop: 14 }}>
          Vendor
        </label>
        <input
          id="vendor"
          value={form.vendor}
          onChange={(e) => set("vendor", e.target.value)}
          maxLength={120}
        />

        <label htmlFor="tags" style={{ marginTop: 14 }}>
          Tags, comma separated
        </label>
        <input id="tags" value={form.tags} onChange={(e) => set("tags", e.target.value)} />

        <label htmlFor="seoTitle" style={{ marginTop: 14 }}>
          Search title
        </label>
        <input
          id="seoTitle"
          value={form.seoTitle}
          onChange={(e) => set("seoTitle", e.target.value)}
          maxLength={120}
          placeholder="Defaults to the product title"
        />

        <label htmlFor="seoDescription" style={{ marginTop: 14 }}>
          Search description
        </label>
        <input
          id="seoDescription"
          value={form.seoDescription}
          onChange={(e) => set("seoDescription", e.target.value)}
          maxLength={320}
        />

        <label className="inline" style={{ marginTop: 14 }}>
          <input
            type="checkbox"
            checked={form.noindex}
            onChange={(e) => set("noindex", e.target.checked)}
          />{" "}
          Keep this product out of search engines
        </label>
      </details>

      {generalIssues.length > 0 && (
        <div className="panel">
          <ul className="error">
            {generalIssues.map((issue, i) => (
              <li key={`${issue.path}-${i}`}>
                {issue.path === "form" ? "" : `${issue.path}: `}
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {saved && <p className="muted">{saved}</p>}

      <button type="submit" disabled={busy || !canWrite}>
        {busy ? "Saving…" : mode === "create" ? "Create product" : "Save changes"}
      </button>
      {!canWrite && <p className="muted">Your role can view the catalog but not change it.</p>}
    </form>
  );
}

function FieldIssues({ issues }: { issues: Issue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="error">
      {issues.map((issue, i) => (
        <li key={`${issue.path}-${i}`}>{issue.message}</li>
      ))}
    </ul>
  );
}

function CheckboxList({
  legend,
  options,
  selected,
  onChange,
  empty,
}: {
  legend: string;
  options: TaxonomyOption[];
  selected: string[];
  onChange: (ids: string[]) => void;
  empty: string;
}) {
  return (
    <fieldset className="axis">
      <legend>{legend}</legend>
      {options.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        options.map((option) => (
          <label key={option.id} className="inline">
            <input
              type="checkbox"
              checked={selected.includes(option.id)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...selected, option.id]
                    : selected.filter((id) => id !== option.id),
                )
              }
            />{" "}
            {option.title}
            {!option.isVisible && <span className="muted"> · hidden</span>}
          </label>
        ))
      )}
    </fieldset>
  );
}
