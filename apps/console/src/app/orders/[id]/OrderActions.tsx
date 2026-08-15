"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Issue = { path: string; message: string };

type Props = {
  orderId: string;
  /**
   * ORDER_TRANSITIONS[current] ∩ MANUAL_ORDER_TRANSITIONS, computed by
   * the server component. Convenience only — the server door
   * (`manualTransition`) is the wall (D12).
   */
  nextStatuses: string[];
  /** Legal per the table AND the actor holds orders:cancel. */
  canCancel: boolean;
  canWrite: boolean;
};

function label(status: string): string {
  return status.replaceAll("_", " ");
}

export function OrderActions({ orderId, nextStatuses, canCancel, canWrite }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [issues, setIssues] = useState<Issue[]>([]);

  async function post(path: string, body: unknown): Promise<void> {
    setBusy(true);
    setIssues([]);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
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
      setCancelOpen(false);
      router.refresh();
    } catch {
      setIssues([{ path: "form", message: "The console could not reach the server." }]);
    } finally {
      setBusy(false);
    }
  }

  if (nextStatuses.length === 0 && !canCancel) return null;

  return (
    <div className="panel">
      <div className="toolbar">
        {canWrite &&
          nextStatuses.map((to) => (
            <button
              key={to}
              type="button"
              disabled={busy}
              onClick={() => post(`/api/orders/${orderId}/transition`, { to })}
            >
              Mark {label(to)}
            </button>
          ))}
        {canCancel && !cancelOpen && (
          <button
            type="button"
            className="chip"
            disabled={busy}
            onClick={() => {
              setCancelOpen(true);
              setIssues([]);
            }}
          >
            Cancel order…
          </button>
        )}
      </div>

      {cancelOpen && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void post(`/api/orders/${orderId}/cancel`, {
              reason: reason.trim() || undefined,
            });
          }}
          style={{ marginTop: 8 }}
        >
          <p className="muted">
            Cancelling restocks the items and, when money was captured, starts a full refund.
          </p>
          <div className="row">
            <div style={{ flex: 1 }}>
              <label htmlFor={`cancel-reason-${orderId}`}>Reason (optional)</label>
              <input
                id={`cancel-reason-${orderId}`}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                placeholder="Buyer asked to cancel, address unserviceable…"
              />
            </div>
          </div>
          <div className="toolbar" style={{ marginTop: 8 }}>
            <button type="submit" disabled={busy}>
              {busy ? "Cancelling…" : "Cancel this order"}
            </button>
            <button
              type="button"
              className="chip"
              onClick={() => setCancelOpen(false)}
              disabled={busy}
            >
              Keep it
            </button>
          </div>
        </form>
      )}

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
    </div>
  );
}
