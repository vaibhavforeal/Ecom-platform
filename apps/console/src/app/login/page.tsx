"use client";

import { useState } from "react";

type Membership = { tenantId: string; tenantName: string; role: string };

/**
 * Phone → OTP → (choose store) → session.
 *
 * Deliberately plain. Phase 0 is about proving the auth and tenancy
 * plumbing; the console's real UI arrives with the features it serves.
 */
export default function LoginPage() {
  const [step, setStep] = useState<"phone" | "code" | "choose">("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function post(url: string, body: unknown) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, data: (await res.json()) as Record<string, unknown> };
  }

  async function requestCode(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { ok, data } = await post("/api/auth/otp/request", { phone });
    setBusy(false);
    if (!ok) {
      setError((data.error as { message?: string })?.message ?? "Could not send code.");
      return;
    }
    setStep("code");
  }

  async function verifyCode(e: React.FormEvent, tenantId?: string) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { ok, data } = await post("/api/auth/otp/verify", { phone, code, tenantId });
    setBusy(false);

    if (!ok) {
      setError((data.error as { message?: string })?.message ?? "That code is not valid.");
      return;
    }
    if (data.needsTenantChoice) {
      setMemberships(data.memberships as Membership[]);
      setStep("choose");
      return;
    }
    window.location.href = "/";
  }

  return (
    <main>
      <h1>Console</h1>
      <p className="muted">Sign in with your registered mobile number.</p>

      <div className="panel">
        {step === "phone" && (
          <form onSubmit={requestCode}>
            <label htmlFor="phone">Mobile number</label>
            <input
              id="phone"
              name="phone"
              type="tel"
              autoComplete="tel"
              inputMode="numeric"
              placeholder="98765 43210"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              required
            />
            <button type="submit" disabled={busy || phone.length < 6}>
              {busy ? "Sending…" : "Send code"}
            </button>
          </form>
        )}

        {step === "code" && (
          <form onSubmit={(e) => verifyCode(e)}>
            <label htmlFor="code">6-digit code</label>
            <input
              id="code"
              name="code"
              type="text"
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              placeholder="••••••"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              required
              autoFocus
            />
            <p className="muted" style={{ marginTop: 8 }}>
              In development the code is printed to the console running{" "}
              <code>pnpm dev</code>.
            </p>
            <button type="submit" disabled={busy || code.length !== 6}>
              {busy ? "Verifying…" : "Sign in"}
            </button>
          </form>
        )}

        {step === "choose" && (
          <div>
            <p className="muted">You staff more than one store. Choose one to open.</p>
            {memberships.map((m) => (
              <button
                key={m.tenantId}
                onClick={(e) => verifyCode(e, m.tenantId)}
                disabled={busy}
                style={{ display: "block", width: "100%", textAlign: "left" }}
              >
                {m.tenantName} · <span style={{ opacity: 0.7 }}>{m.role}</span>
              </button>
            ))}
          </div>
        )}

        {error && <p className="error">{error}</p>}
      </div>
    </main>
  );
}
