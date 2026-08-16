"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { CART_LINE_MAX_QUANTITY } from "@platform/core/cart";

/**
 * The cart page's interactivity: quantity steppers, line removal and the
 * coupon form. Client components importing PURE barrels only — the page
 * itself renders on the server from an uncached live read, and every
 * mutation here round-trips through /api/cart then router.refresh()es so
 * the server render stays the single source of truth.
 */

type Envelope = {
  error?: { code: string; message: string; details?: { issues?: { message: string }[] } };
};

function messageFrom(body: Envelope, fallback: string): string {
  return body.error?.details?.issues?.[0]?.message ?? body.error?.message ?? fallback;
}

export function LineQuantity({
  variantId,
  quantity,
  available,
}: {
  variantId: string;
  quantity: number;
  /** null = untracked (cannot run out). */
  available: number | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function setQuantity(next: number) {
    if (next < 0 || next > CART_LINE_MAX_QUANTITY) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/cart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ variantId, quantity: next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Envelope;
        setError(messageFrom(body, "Could not update the cart."));
        return;
      }
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  const atCap =
    quantity >= CART_LINE_MAX_QUANTITY || (available !== null && quantity >= available);

  return (
    <span className="cart-line-controls">
      <button
        type="button"
        className="chip"
        disabled={pending}
        aria-label="Decrease quantity"
        onClick={() => void setQuantity(quantity - 1)}
      >
        −
      </button>
      <span aria-live="polite"> {quantity} </span>
      <button
        type="button"
        className="chip"
        disabled={pending || atCap}
        aria-label="Increase quantity"
        onClick={() => void setQuantity(quantity + 1)}
      >
        +
      </button>{" "}
      <button
        type="button"
        className="chip"
        disabled={pending}
        onClick={() => void setQuantity(0)}
      >
        Remove
      </button>
      {error && <span className="muted"> {error}</span>}
    </span>
  );
}

export function CouponForm({ couponCode }: { couponCode: string | null }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(method: "POST" | "DELETE") {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/cart/coupon", {
        method,
        headers: { "content-type": "application/json" },
        body: method === "POST" ? JSON.stringify({ code }) : undefined,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Envelope;
        setError(messageFrom(body, "Could not update the coupon."));
        return;
      }
      setCode("");
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  if (couponCode) {
    return (
      <p>
        Coupon <code>{couponCode}</code>{" "}
        <button type="button" className="chip" disabled={pending} onClick={() => void submit("DELETE")}>
          Remove
        </button>
        {error && <span className="muted"> {error}</span>}
      </p>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (code.trim()) void submit("POST");
      }}
    >
      <label>
        Coupon code{" "}
        <input
          type="text"
          value={code}
          maxLength={40}
          onChange={(e) => setCode(e.target.value)}
          placeholder="SUMMER10"
        />
      </label>{" "}
      <button type="submit" className="chip" disabled={pending || !code.trim()}>
        Apply
      </button>
      {error && <span className="muted"> {error}</span>}
    </form>
  );
}
