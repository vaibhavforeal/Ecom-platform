import type { Metadata } from "next";
import Link from "next/link";

import { formatPaise } from "@platform/core/catalog";
import { getCartView } from "@platform/core/cart/server";
import { getShippingFeeQuote } from "@platform/core/serviceability/server";

import { readCartId } from "../../lib/cart-cookie";
import { requireTenant } from "../../lib/tenant";
import { CheckoutForm } from "./CheckoutForm";

/**
 * Checkout. Rendered per request, never statically; the cart read and
 * the shipping-fee settings read are live and uncached — a price or
 * policy change must be visible on the very next load, and the page is
 * per-buyer anyway.
 *
 * The form posts to B-INT's POST /api/checkout against the S0-frozen
 * CheckoutPayload/CheckoutStartResponse contract (see CheckoutForm).
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Checkout",
  robots: { index: false, follow: false },
};

export default async function CheckoutPage() {
  const tenant = await requireTenant();
  const cartId = await readCartId();
  const ctx = { tenantId: tenant.tenantId };
  const cart = cartId ? await getCartView(ctx, cartId) : null;

  if (!cart || cart.status !== "active" || cart.lines.length === 0) {
    return (
      <main>
        <h1>Checkout</h1>
        <p className="muted">Your cart is empty.</p>
        <p>
          <Link href="/">Continue shopping</Link>
        </p>
      </main>
    );
  }

  // Display estimate only — checkout-start recomputes the fee inside the
  // order transaction from the same settings (§1.10).
  const discount = cart.couponPreview?.applicable ? cart.couponPreview.discountPaise : 0;
  const freeShipping = cart.couponPreview?.applicable === true && cart.couponPreview.freeShipping;
  const quote = await getShippingFeeQuote(ctx, cart.subtotalPaise);
  const shippingFeePaise = freeShipping ? 0 : quote.feePaise;

  return (
    <main>
      <h1>Checkout</h1>

      <section className="panel">
        <h2>Your order</h2>
        <ul>
          {cart.lines.map((line) => (
            <li key={line.variantId}>
              {line.title} × {line.quantity} —{" "}
              {formatPaise(line.lineTotalPaise, { currency: cart.currency })}
            </li>
          ))}
        </ul>
        {discount > 0 && (
          <p className="muted">
            Coupon <code>{cart.couponCode}</code>: −
            {formatPaise(discount, { currency: cart.currency })}
          </p>
        )}
        <p>
          <Link href="/cart">Edit cart</Link>
        </p>
      </section>

      <CheckoutForm
        subtotalPaise={cart.subtotalPaise - discount}
        shippingFeePaise={shippingFeePaise}
        currency={cart.currency}
        couponCode={cart.couponCode}
      />
    </main>
  );
}
