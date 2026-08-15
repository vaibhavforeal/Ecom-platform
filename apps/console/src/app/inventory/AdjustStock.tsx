"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Issue = { path: string; message: string };

type Props = {
  variantId: string;
  sku: string;
  onHand: number;
  canWrite: boolean;
};

export function AdjustStock({ variantId, sku, onHand, canWrite }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [delta, setDelta] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [idemKey, setIdemKey] = useState("");

  function openDialog(): void {
    setOpen(true);
    setDelta("");
    setNote("");
    setIssues([]);
    setIdemKey(crypto.randomUUID());
  }

  const parsed = /^-?\d+$/.test(delta.trim()) ? Number.parseInt(delta.trim(), 10) : null;
  const preview = parsed === null ? null : onHand + parsed;
  const submittable = parsed !== null && parsed !== 0 && note.trim().length > 0 && !busy;

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (parsed === null) return;
    setBusy(true);
    setIssues([]);
    try {
      const res = await fetch("/api/inventory/movements", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ variantId, delta: parsed, note: note.trim(), idempotencyKey: idemKey }),
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
      setOpen(false);
      router.refresh();
    } catch {
      setIssues([{ path: "form", message: "The console could not reach the server." }]);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="chip" onClick={openDialog} disabled={!canWrite}>
        Adjust
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="panel" style={{ marginTop: 8 }}>
      <p className="muted">
        {sku}: {onHand} on hand
        {preview !== null && <> → <strong>{preview}</strong></>}
      </p>
      <div className="row">
        <div>
          <label htmlFor={`delta-${variantId}`}>Change (± quantity)</label>
          <input
            id={`delta-${variantId}`}
            value={delta}
            onChange={(e) => setDelta(e.target.value)}
            inputMode="numeric"
            placeholder="+5 or -2"
            autoFocus
          />
        </div>
        <div style={{ flex: 1 }}>
          <label htmlFor={`note-${variantId}`}>Note (required)</label>
          <input
            id={`note-${variantId}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={500}
            placeholder="Stock count, damage, correction…"
          />
        </div>
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
      <div className="toolbar" style={{ marginTop: 8 }}>
        <button type="submit" disabled={!submittable}>
          {busy ? "Saving…" : "Save movement"}
        </button>
        <button type="button" className="chip" onClick={() => setOpen(false)} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
