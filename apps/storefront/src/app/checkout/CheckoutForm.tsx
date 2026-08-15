"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { formatPaise } from "@platform/core/catalog";
import { CHECKOUT_PAYMENT_MODES } from "@platform/core/checkout";
import type {
  CheckoutPayload,
  CheckoutPaymentMode,
  CheckoutStartResponse,
} from "@platform/core/checkout";
import { GST_STATE_NAMES, PINCODE_PREFIX_STATES, PINCODE_RE } from "@platform/core/serviceability";

/**
 * The checkout form. A client component importing PURE barrels only —
 * payload/response types are the S0-frozen contract for B-INT's
 * POST /api/checkout, so this page needs no rewiring when that route
 * lands: it already renders BOTH response arms (confirmed → guest order
 * page; payment_required → gateway hand-off shell that B-INT wires to
 * the real gateway script).
 */

const MODE_LABELS: Record<CheckoutPaymentMode, string> = {
  prepaid: "Pay online",
  cod: "Cash on delivery",
  cod_advance: "Pay part now, rest on delivery",
};

type Envelope = {
  error?: {
    code: string;
    message: string;
    details?: { issues?: { path: string; message: string }[] };
  };
};

type Serviceability =
  | { state: "unknown" }
  | { state: "checking" }
  | { state: "serviceable" }
  | { state: "unserviceable"; message: string };

export function CheckoutForm({
  subtotalPaise,
  shippingFeePaise,
  currency,
  couponCode,
}: {
  subtotalPaise: number;
  shippingFeePaise: number;
  currency: string;
  couponCode: string | null;
}) {
  const router = useRouter();

  // One idempotency key per form mount: a double-click or a network retry
  // replays the same checkout instead of creating a second order (D1a).
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const [buyerName, setBuyerName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [line1, setLine1] = useState("");
  const [line2, setLine2] = useState("");
  const [city, setCity] = useState("");
  const [stateCode, setStateCode] = useState("");
  const [pincode, setPincode] = useState("");
  const [paymentMode, setPaymentMode] = useState<CheckoutPaymentMode>("prepaid");

  const [serviceability, setServiceability] = useState<Serviceability>({ state: "unknown" });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<{ path: string; message: string }[]>([]);
  const [handOff, setHandOff] = useState<Extract<
    CheckoutStartResponse,
    { status: "payment_required" }
  > | null>(null);

  // The same static prefix map the server cross-checks with (D3) — used
  // here only to WARN early; the server's 422 pincode_state_mismatch is
  // the enforcement.
  const allowedStates = PINCODE_RE.test(pincode)
    ? (PINCODE_PREFIX_STATES[pincode.slice(0, 2)] ?? [])
    : [];
  const stateMismatch =
    stateCode !== "" && allowedStates.length > 0 && !allowedStates.includes(stateCode);

  async function precheckPincode() {
    if (!PINCODE_RE.test(pincode)) return;
    setServiceability({ state: "checking" });
    try {
      const res = await fetch("/api/checkout/serviceability", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pincode }),
      });
      const body = (await res.json().catch(() => ({}))) as Envelope & { serviceable?: boolean };
      if (res.ok && body.serviceable) {
        setServiceability({ state: "serviceable" });
      } else {
        setServiceability({
          state: "unserviceable",
          message: body.error?.message ?? "Delivery is not available to this pincode.",
        });
      }
    } catch {
      setServiceability({ state: "unknown" });
    }
  }

  async function submit() {
    setPending(true);
    setError(null);
    setIssues([]);
    try {
      const payload: CheckoutPayload = {
        idempotencyKey,
        buyerName: buyerName.trim(),
        phone: phone.trim(),
        email: email.trim() || null,
        shippingAddress: {
          line1: line1.trim(),
          line2: line2.trim() || null,
          city: city.trim(),
          stateCode,
          pincode,
        },
        couponCode,
        paymentMode,
      };

      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Envelope;
        setError(body.error?.message ?? "Checkout is not available right now.");
        setIssues(body.error?.details?.issues ?? []);
        return;
      }

      const result = (await res.json()) as CheckoutStartResponse;
      if (result.status === "confirmed") {
        router.push(`/order/${result.orderId}?t=${encodeURIComponent(result.orderToken)}`);
        return;
      }
      // payment_required: hand off to the gateway. The concrete gateway
      // script invocation is wired by B-INT; this shell already carries
      // everything it needs.
      setHandOff(result);
    } finally {
      setPending(false);
    }
  }

  if (handOff) {
    return (
      <section className="panel">
        <h2>Complete your payment</h2>
        <p>
          Amount due now: <strong>{formatPaise(handOff.amountPaise, { currency })}</strong>
        </p>
        <p className="muted">
          Payment reference <code>{handOff.gatewayOrderId}</code> · key{" "}
          <code>{handOff.publicKeyId}</code>
        </p>
        <p className="muted">
          You will be taken to your store&apos;s payment provider to finish paying. Once the
          payment is confirmed you can track your order{" "}
          <a href={`/order/${handOff.orderId}?t=${encodeURIComponent(handOff.orderToken)}`}>
            here
          </a>
          .
        </p>
      </section>
    );
  }

  const totalPaise = subtotalPaise + shippingFeePaise;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <fieldset>
        <legend>Contact</legend>
        <p>
          <label>
            Name{" "}
            <input
              type="text"
              value={buyerName}
              onChange={(e) => setBuyerName(e.target.value)}
              required
              maxLength={120}
            />
          </label>
        </p>
        <p>
          <label>
            Phone{" "}
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+91…"
              required
            />
          </label>
        </p>
        <p>
          <label>
            Email (optional){" "}
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
        </p>
      </fieldset>

      <fieldset>
        <legend>Delivery address</legend>
        <p>
          <label>
            Address line 1{" "}
            <input type="text" value={line1} onChange={(e) => setLine1(e.target.value)} required />
          </label>
        </p>
        <p>
          <label>
            Address line 2 (optional){" "}
            <input type="text" value={line2} onChange={(e) => setLine2(e.target.value)} />
          </label>
        </p>
        <p>
          <label>
            City{" "}
            <input type="text" value={city} onChange={(e) => setCity(e.target.value)} required />
          </label>
        </p>
        <p>
          <label>
            State{" "}
            <select value={stateCode} onChange={(e) => setStateCode(e.target.value)} required>
              <option value="">Select a state…</option>
              {Object.entries(GST_STATE_NAMES).map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        </p>
        <p>
          <label>
            Pincode{" "}
            <input
              type="text"
              inputMode="numeric"
              value={pincode}
              onChange={(e) => {
                setPincode(e.target.value);
                setServiceability({ state: "unknown" });
              }}
              onBlur={() => void precheckPincode()}
              pattern="[1-9][0-9]{5}"
              required
            />
          </label>{" "}
          {serviceability.state === "checking" && <span className="muted">Checking…</span>}
          {serviceability.state === "serviceable" && (
            <span className="muted">Delivery available.</span>
          )}
          {serviceability.state === "unserviceable" && (
            <span className="muted">{serviceability.message}</span>
          )}
        </p>
        {stateMismatch && (
          <p className="muted">
            That pincode does not look like it is in {GST_STATE_NAMES[stateCode]}. Please check
            the state or the pincode.
          </p>
        )}
      </fieldset>

      <fieldset>
        <legend>Payment</legend>
        {CHECKOUT_PAYMENT_MODES.map((mode) => (
          <p key={mode}>
            <label>
              <input
                type="radio"
                name="paymentMode"
                value={mode}
                checked={paymentMode === mode}
                onChange={() => setPaymentMode(mode)}
              />{" "}
              {MODE_LABELS[mode]}
            </label>
          </p>
        ))}
      </fieldset>

      <p>
        Subtotal: {formatPaise(subtotalPaise, { currency })} · Shipping:{" "}
        {shippingFeePaise === 0 ? "Free" : formatPaise(shippingFeePaise, { currency })} ·{" "}
        <strong>Total: {formatPaise(totalPaise, { currency })}</strong>
      </p>
      {couponCode && (
        <p className="muted">
          Coupon <code>{couponCode}</code> will be applied when the order is placed.
        </p>
      )}

      {error && <p className="muted">{error}</p>}
      {issues.length > 0 && (
        <ul className="muted">
          {issues.map((issue, i) => (
            <li key={`${issue.path}-${i}`}>
              {issue.path}: {issue.message}
            </li>
          ))}
        </ul>
      )}

      <p>
        <button
          type="submit"
          className="chip"
          disabled={pending || serviceability.state === "unserviceable" || stateMismatch}
        >
          {pending ? "Placing order…" : "Place order"}
        </button>
      </p>
    </form>
  );
}
