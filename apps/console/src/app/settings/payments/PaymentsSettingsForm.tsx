"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Issue = { path: string; message: string };

/**
 * Local mirror of the fingerprint-only server view. Deliberately NOT
 * imported from the server barrel — this is a client component and may
 * only see pure shapes; there is no secret field to mirror because the
 * server never returns one.
 */
type AccountView = {
  providerCode: string;
  label: string;
  publicKeyId: string;
  credentialFingerprint: string;
  isEnabled: boolean;
  lastVerifiedAt: string | null;
  lastError: string | null;
};

type Props = {
  account: AccountView | null;
  webhookUrl: string | null;
  providers: string[];
};

const PROVIDER_LABELS: Record<string, string> = {
  razorpay: "Razorpay",
  mock: "Mock gateway (development)",
};

export function PaymentsSettingsForm({ account, webhookUrl, providers }: Props) {
  const router = useRouter();

  const [providerCode, setProviderCode] = useState(account?.providerCode ?? providers[0] ?? "razorpay");
  const [publicKeyId, setPublicKeyId] = useState(account?.publicKeyId ?? "");
  // Secrets are WRITE-ONLY: these fields start empty even when an account
  // exists — the server shows a fingerprint, never the value.
  const [keySecret, setKeySecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [isEnabled, setIsEnabled] = useState(account?.isEnabled ?? true);

  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testBusy, setTestBusy] = useState(false);

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setIssues([]);
    setSaved(null);
    setTestResult(null);

    try {
      const res = await fetch("/api/settings/payments", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ providerCode, publicKeyId, keySecret, webhookSecret, isEnabled }),
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

      // Never keep secrets in component state past the save.
      setKeySecret("");
      setWebhookSecret("");
      setSaved("Saved. Secrets are sealed — only the fingerprint below is kept visible.");
      router.refresh();
    } catch {
      setIssues([{ path: "form", message: "The console could not reach the server." }]);
    } finally {
      setBusy(false);
    }
  }

  async function copyWebhookUrl(): Promise<void> {
    if (!webhookUrl) return;
    try {
      await navigator.clipboard.writeText(webhookUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  async function sendTestEvent(): Promise<void> {
    setTestBusy(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/settings/payments/test-event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = (await res.json()) as {
        delivered?: boolean;
        storefrontStatus?: number;
        eventId?: string;
        error?: { message?: string };
      };
      if (!res.ok) {
        setTestResult(data.error?.message ?? "The test event could not be sent.");
        return;
      }
      setTestResult(
        data.delivered
          ? `Delivered — the storefront webhook answered ${data.storefrontStatus} for event ${data.eventId}.`
          : `The storefront webhook answered ${data.storefrontStatus} — check the storefront logs for event ${data.eventId}.`,
      );
    } catch {
      setTestResult("The console could not reach the server.");
    } finally {
      setTestBusy(false);
    }
  }

  return (
    <div>
      <form onSubmit={save} className="panel">
        <h2 style={{ fontSize: 15, margin: "0 0 12px" }}>Gateway credentials</h2>

        <p className="muted">
          Payments go straight to your own gateway account — the platform never touches the money.
          Secrets are sealed on save and never shown again.
        </p>

        {account && (
          <p className="muted">
            Current: <strong>{PROVIDER_LABELS[account.providerCode] ?? account.providerCode}</strong>{" "}
            — key <code>{account.publicKeyId}</code>, secret {account.credentialFingerprint},{" "}
            {account.isEnabled ? "enabled" : "disabled"}.
            {account.lastError ? ` Last error: ${account.lastError}` : ""}
          </p>
        )}

        <div className="section">
          <label style={{ display: "block", marginBottom: 8 }}>
            Provider{" "}
            <select value={providerCode} onChange={(e) => setProviderCode(e.target.value)}>
              {providers.map((code) => (
                <option key={code} value={code}>
                  {PROVIDER_LABELS[code] ?? code}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: "block", marginBottom: 8 }}>
            Key id{" "}
            <input
              type="text"
              value={publicKeyId}
              onChange={(e) => setPublicKeyId(e.target.value)}
              placeholder="rzp_live_…"
              autoComplete="off"
            />
          </label>

          <label style={{ display: "block", marginBottom: 8 }}>
            Key secret{" "}
            <input
              type="password"
              value={keySecret}
              onChange={(e) => setKeySecret(e.target.value)}
              placeholder={account ? "Unchanged unless re-entered on save" : ""}
              autoComplete="new-password"
            />
          </label>

          <label style={{ display: "block", marginBottom: 8 }}>
            Webhook secret{" "}
            <input
              type="password"
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
              autoComplete="new-password"
            />
          </label>

          <label style={{ display: "block", marginBottom: 8 }}>
            <input
              type="checkbox"
              checked={isEnabled}
              onChange={(e) => setIsEnabled(e.target.checked)}
            />{" "}
            Enabled — this gateway takes checkout payments
          </label>
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

        <button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </form>

      <div className="panel" style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: 15, margin: "0 0 12px" }}>Webhook</h2>

        {webhookUrl ? (
          <div>
            <p className="muted">
              Register this URL in your gateway dashboard so payment confirmations reach the store.
              Webhooks — not browser redirects — are what confirm an order.
            </p>
            <p>
              <input type="text" readOnly value={webhookUrl} style={{ width: "28rem", maxWidth: "100%" }} />{" "}
              <button type="button" onClick={copyWebhookUrl}>
                {copied ? "Copied" : "Copy"}
              </button>
            </p>
          </div>
        ) : (
          <p className="muted">Verify a domain to get your webhook URL.</p>
        )}

        {account?.providerCode === "mock" && account.isEnabled && (
          <div className="section">
            <p className="muted">
              The mock gateway can send a signed test event through the real webhook route.
            </p>
            <button type="button" onClick={sendTestEvent} disabled={testBusy}>
              {testBusy ? "Sending…" : "Send test event"}
            </button>
            {testResult && <p className="muted">{testResult}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
