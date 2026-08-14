"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Mode = "auto" | "indexed" | "noindex";
type Issue = { path: string; message: string };

type Props = {
  current: Mode;
  status: string;
  indexable: boolean;
  canWrite: boolean;
};

const OPTIONS: { value: Mode; label: string; detail: string }[] = [
  {
    value: "auto",
    label: "Automatic",
    detail: "Search engines may index this store once it is active. Trial stores stay hidden.",
  },
  {
    value: "indexed",
    label: "Always indexed",
    detail: "Ask search engines to index this store, even during a trial.",
  },
  {
    value: "noindex",
    label: "Hidden",
    detail: "Ask search engines not to index this store.",
  },
];

export function SearchIndexingForm({ current, status, indexable, canWrite }: Props) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(current);
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [saved, setSaved] = useState<string | null>(null);

  // isSearchIndexable's platform override: these two statuses are never
  // indexed, whatever the merchant chooses. Rendered, not re-derived —
  // the server computed `indexable` with the real function.
  const overridden = status === "suspended" || status === "churned";

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setIssues([]);
    setSaved(null);

    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ searchIndexing: mode }),
      });

      const data = (await res.json()) as {
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

      setSaved("Saved.");
      router.refresh();
    } catch {
      setIssues([{ path: "form", message: "The console could not reach the server." }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="panel">
      <h2 style={{ fontSize: 15, margin: "0 0 12px" }}>Search engine indexing</h2>

      <p className="muted">
        Search engines are currently {indexable ? "allowed" : "not allowed"} to index this store.
      </p>
      {overridden && (
        <p className="muted">
          This store is {status}, so it stays out of search engines whatever is chosen here.
        </p>
      )}

      <div className="section">
        {OPTIONS.map((option) => (
          <label key={option.value} style={{ display: "block", marginBottom: 8 }}>
            <input
              type="radio"
              name="searchIndexing"
              value={option.value}
              checked={mode === option.value}
              onChange={() => setMode(option.value)}
              disabled={!canWrite}
            />{" "}
            <strong>{option.label}</strong>
            <span className="muted"> — {option.detail}</span>
          </label>
        ))}
      </div>

      {issues.length > 0 && (
        <ul className="error">
          {issues.map((issue, i) => (
            <li key={`${issue.path}-${i}`}>
              {issue.path === "form" ? "" : `${issue.path}: `}
              {issue.message}
            </li>
          ))}
        </ul>
      )}

      {saved && <p className="muted">{saved}</p>}

      <p className="muted">
        The storefront updates right away. robots.txt may be cached by a CDN for up to an hour.
      </p>

      <button type="submit" disabled={busy || !canWrite}>
        {busy ? "Saving…" : "Save"}
      </button>
      {!canWrite && <p className="muted">Your role can view settings but not change them.</p>}
    </form>
  );
}
