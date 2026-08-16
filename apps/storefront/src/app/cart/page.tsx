import type { Metadata } from "next";
import Link from "next/link";

import { formatPaise } from "@platform/core/catalog";
import { getCartView } from "@platform/core/cart/server";

import { readCartId } from "../../lib/cart-cookie";
import { requireTenant } from "../../lib/tenant";
import { CouponForm, LineQuantity } from "./CartControls";

/**
 * The cart page. Rendered per request, never statically, and the read is
 * NEVER unstable_cache'd — this is live commerce state (prices read live
 * from the catalog, availability subtracting active holds), not
 * catalog-shaped content. See CONVENTIONS_BRIEF §4.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Cart",
  robots: { index: false, follow: false },
};

export default async function CartPage() {
  const tenant = await requireTenant();
  const cartId = await readCartId();
  const cart = cartId ? await getCartView({ tenantId: tenant.tenantId }, cartId) : null;

  if (!cart || cart.status !== "active" || cart.lines.length === 0) {
    return (
      <main>
        <h1>Cart</h1>
        <p className="muted">Your cart is empty.</p>
        <p>
          <Link href="/">Continue shopping</Link>
        </p>
      </main>
    );
  }

  const discount = cart.couponPreview?.applicable ? cart.couponPreview.discountPaise : 0;

  return (
    <main>
      <h1>Cart</h1>

      <table className="grid">
        <thead>
          <tr>
            <th>Item</th>
            <th style={{ textAlign: "right" }}>Price</th>
            <th style={{ textAlign: "center" }}>Quantity</th>
            <th style={{ textAlign: "right" }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {cart.lines.map((line) => (
            <tr key={line.variantId}>
              <td>
                {line.title}
                {Object.keys(line.options).length > 0 && (
                  <div className="muted">
                    {Object.entries(line.options)
                      .map(([axis, value]) => `${axis}: ${value}`)
                      .join(" · ")}
                  </div>
                )}
                {line.available !== null && line.available < line.quantity && (
                  <div className="muted">Only {line.available} left in stock.</div>
                )}
              </td>
              <td style={{ textAlign: "right" }}>
                {formatPaise(line.unitPricePaise, { currency: cart.currency })}
              </td>
              <td style={{ textAlign: "center" }}>
                <LineQuantity
                  variantId={line.variantId}
                  quantity={line.quantity}
                  available={line.available}
                />
              </td>
              <td style={{ textAlign: "right" }}>
                {formatPaise(line.lineTotalPaise, { currency: cart.currency })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <CouponForm couponCode={cart.couponCode} />
      {cart.couponPreview && !cart.couponPreview.applicable && (
        <p className="muted">
          Coupon <code>{cart.couponPreview.code}</code> does not apply
          {cart.couponPreview.reason ? ` (${cart.couponPreview.reason.replaceAll("_", " ")})` : ""}.
        </p>
      )}

      <p>
        Subtotal: <strong>{formatPaise(cart.subtotalPaise, { currency: cart.currency })}</strong>
        {discount > 0 && (
          <>
            {" "}
            · Coupon savings: −{formatPaise(discount, { currency: cart.currency })}
            {cart.couponPreview?.freeShipping && " · Free shipping"}
          </>
        )}
      </p>
      <p className="muted">Shipping and taxes are settled at checkout.</p>

      <p>
        <Link href="/checkout" className="chip">
          Checkout
        </Link>{" "}
        <Link href="/">Continue shopping</Link>
      </p>
    </main>
  );
}
