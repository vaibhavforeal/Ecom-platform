"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Categories and collections.
 *
 * Deliberately smaller than the product form. A category is a title, a
 * URL, a parent and a visibility flag — everything else about it (which
 * products are in it) is edited from the product, where the merchant is
 * already looking. What it does share with the product form is slug
 * handling: renaming records the old URL and keeps redirecting it.
 */

export type TaxonomyRow = {
  id: string;
  title: string;
  slug: string | null;
  description: string | null;
  parentId: string | null;
  position: number;
  isVisible: boolean;
  productCount: number;
};

type Issue = { path: string; message: string };
type Kind = "categories" | "collections";

type Draft = {
  title: string;
  slug: string;
  description: string;
  parentId: string;
  position: string;
  isVisible: boolean;
};

function draftFrom(row: TaxonomyRow): Draft {
  return {
    title: row.title,
    slug: row.slug ?? "",
    description: row.description ?? "",
    parentId: row.parentId ?? "",
    position: String(row.position),
    isVisible: row.isVisible,
  };
}

const EMPTY: Draft = {
  title: "",
  slug: "",
  description: "",
  parentId: "",
  position: "0",
  isVisible: true,
};

export function TaxonomyEditor({
  kind,
  rows,
  canWrite,
}: {
  kind: Kind;
  rows: TaxonomyRow[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const isCategory = kind === "categories";
  const label = isCategory ? "category" : "collection";

  function startNew(): void {
    setEditing("new");
    setDraft(EMPTY);
    setIssues([]);
    setNote(null);
  }

  function startEdit(row: TaxonomyRow): void {
    setEditing(row.id);
    setDraft(draftFrom(row));
    setIssues([]);
    setNote(null);
  }

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (editing === null) return;

    setBusy(true);
    setIssues([]);
    setNote(null);

    const payload = {
      title: draft.title,
      slug: draft.slug.trim() || null,
      description: draft.description,
      parentId: isCategory ? draft.parentId || null : null,
      position: Number.parseInt(draft.position, 10) || 0,
      isVisible: draft.isVisible,
      seo: {},
    };

    try {
      const res = await fetch(
        editing === "new" ? `/api/${kind}` : `/api/${kind}/${editing}`,
        {
          method: editing === "new" ? "POST" : "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        },
      );

      const data = (await res.json()) as {
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

      setNote(
        data.previousSlug
          ? `Saved. /${data.previousSlug} now redirects to /${data.slug}.`
          : `Saved as /${data.slug}.`,
      );
      setEditing(null);
      router.refresh();
    } catch {
      setIssues([{ path: "form", message: "The console could not reach the server." }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel">
      <h2 className="section">{isCategory ? "Categories" : "Collections"}</h2>
      <p className="muted">
        {isCategory
          ? "Where a product belongs. One parent each, and the breadcrumbs follow the tree."
          : "Curated groupings — a sale, a season. A product may be in many."}
      </p>

      {rows.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>Title</th>
              <th>URL</th>
              <th style={{ textAlign: "right" }}>Products</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  {row.title}
                  {!row.isVisible && <span className="muted"> · hidden</span>}
                </td>
                <td>{row.slug ? <code>/{row.slug}</code> : <span className="muted">—</span>}</td>
                <td style={{ textAlign: "right" }}>{row.productCount}</td>
                <td>
                  {canWrite && (
                    <button type="button" className="chip" onClick={() => startEdit(row)}>
                      Edit
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {note && <p className="muted">{note}</p>}

      {canWrite && editing === null && (
        <button type="button" className="chip" onClick={startNew}>
          New {label}
        </button>
      )}

      {editing !== null && (
        <form onSubmit={save} style={{ marginTop: 18 }}>
          <label htmlFor={`${kind}-title`}>Title</label>
          <input
            id={`${kind}-title`}
            value={draft.title}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            maxLength={120}
            required
          />

          <label htmlFor={`${kind}-slug`} style={{ marginTop: 14 }}>
            URL
          </label>
          <input
            id={`${kind}-slug`}
            value={draft.slug}
            onChange={(e) => setDraft({ ...draft, slug: e.target.value })}
            placeholder="derived from the title"
            maxLength={96}
          />
          <p className="muted">Renaming keeps the old URL redirecting.</p>

          <label htmlFor={`${kind}-description`} style={{ marginTop: 14 }}>
            Description
          </label>
          <input
            id={`${kind}-description`}
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            maxLength={2000}
          />

          {isCategory && (
            <>
              <label htmlFor={`${kind}-parent`} style={{ marginTop: 14 }}>
                Parent
              </label>
              <select
                id={`${kind}-parent`}
                value={draft.parentId}
                onChange={(e) => setDraft({ ...draft, parentId: e.target.value })}
              >
                <option value="">None — top level</option>
                {rows
                  .filter((r) => r.id !== editing)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.title}
                    </option>
                  ))}
              </select>
            </>
          )}

          <label htmlFor={`${kind}-position`} style={{ marginTop: 14 }}>
            Position
          </label>
          <input
            id={`${kind}-position`}
            value={draft.position}
            onChange={(e) => setDraft({ ...draft, position: e.target.value })}
            inputMode="numeric"
          />

          <label className="inline" style={{ marginTop: 14 }}>
            <input
              type="checkbox"
              checked={draft.isVisible}
              onChange={(e) => setDraft({ ...draft, isVisible: e.target.checked })}
            />{" "}
            Visible on the storefront
          </label>

          {issues.length > 0 && (
            <ul className="error">
              {issues.map((issue, i) => (
                <li key={`${issue.path}-${i}`}>{issue.message}</li>
              ))}
            </ul>
          )}

          <div className="toolbar">
            <button type="submit" disabled={busy}>
              {busy ? "Saving…" : editing === "new" ? `Create ${label}` : "Save"}
            </button>
            <button type="button" className="chip" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
