import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { formatPaise } from "@platform/core/catalog";
import { getOrderDetail } from "@platform/core/orders/server";

import { verifyOrderToken } from "../../../lib/order-token";
import { requireTenant } from "../../../lib/tenant";

/**
 * Guest order status (spec §7): `/order/[id]?t=<hmac>`.
 *
 * No buyer login exists, so the token IS the authorisation: an HMAC of
 * the order id under SESSION_SECRET, compared constant-time
 * (lib/order-token). A missing or wrong token is a plain 404 — the page
 * must not confirm that an order id exists to someone without its token.
 * Tenant from the Host as always, so a valid token replayed against
 * another tenant's domain still finds nothing (RLS).
 *
 * Rendered per request, never statically, never cached: this is live
 * order state.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your order",
  robots: { index: false, follow: false },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUS_LABELS: Record<string, string> = {
  pending_payment: "Awaiting payment",
  confirmed: "Confirmed",
  processing: "Being prepared",
  ready_to_ship: "Ready to ship",
  shipped: "Shipped",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  cancelled: "Cancelled",
  abandoned: "Not completed",
  rto_initiated: "Returning to seller",
  rto_delivered: "Returned to seller",
  return_requested: "Return requested",
  return_picked: "Return picked up",
  refunded: "Refunded",
};

type Params = { params: Promise<{ id: string }> };
type Search = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function OrderStatusPage({ params, searchParams }: Params & Search) {
  const tenant = await requireTenant();
  const { id } = await params;
  const query = await searchParams;
  const token = Array.isArray(query.t) ? query.t[0] : query.t;

  // Malformed id → 404 before any query (never a uuid cast error), and
  // the token gate comes BEFORE the database read: without the token this
  // page reveals nothing, not even whether the id exists.
  if (!UUID_RE.test(id)) notFound();
  if (!verifyOrderToken(id, token)) notFound();

  const order = await getOrderDetail(tenant.tenantId, id);
  if (!order) notFound();

  const currency = order.currency;
  const itemLines = order.lines.filter((l) => l.kind === "item");
  const shippingLine = order.lines.find((l) => l.kind === "shipping");

  return (
    <main>
      <h1>Order #{order.orderNumber}</h1>
      <p>
        Status: <strong>{STATUS_LABELS[order.status] ?? order.status}</strong>
        {order.status === "cancelled" && order.cancelReason === "stock_shortfall" && (
          <span className="muted">
            {" "}
            — an item sold out before payment completed. Any amount paid is being refunded.
          </span>
        )}
      </p>

      <table className="grid">
        <thead>
          <tr>
            <th>Item</th>
            <th style={{ textAlign: "right" }}>Quantity</th>
            <th style={{ textAlign: "right" }}>Total</th>
          </tr>
        </thead>
        <tbody>
          {itemLines.map((line) => (
            <tr key={line.id}>
              <td>
                {line.titleSnapshot}
                {line.skuSnapshot && <div className="muted">SKU {line.skuSnapshot}</div>}
              </td>
              <td style={{ textAlign: "right" }}>{line.quantity}</td>
              <td style={{ textAlign: "right" }}>{formatPaise(line.totalPaise, { currency })}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p>
        Subtotal: {formatPaise(order.subtotalPaise, { currency })}
        {order.discountPaise > 0 && (
          <>
            {" "}
            · Discount: −{formatPaise(order.discountPaise, { currency })}
            {order.couponCodeSnapshot && (
              <>
                {" "}
                (<code>{order.couponCodeSnapshot}</code>)
              </>
            )}
          </>
        )}{" "}
        · Shipping:{" "}
        {order.shippingPaise === 0
          ? "Free"
          : formatPaise(shippingLine?.totalPaise ?? order.shippingPaise, { currency })}{" "}
        · <strong>Total: {formatPaise(order.totalPaise, { currency })}</strong>
      </p>
      <p className="muted">
        Paid: {formatPaise(order.amountPaidPaise, { currency })}
        {order.codDuePaise > 0 && (
          <> · Due on delivery: {formatPaise(order.codDuePaise, { currency })}</>
        )}
      </p>

      <section>
        <h2>Delivery address</h2>
        <p className="muted">
          {[
            order.shippingAddress.line1,
            order.shippingAddress.line2,
            order.shippingAddress.city,
            order.shippingAddress.pincode,
          ]
            .filter((part): part is string => typeof part === "string" && part.length > 0)
            .join(", ")}
        </p>
      </section>

      {order.invoice && (
        <section>
          <h2>{order.invoice.docType === "bill_of_supply" ? "Bill of Supply" : "Tax Invoice"}</h2>
          <p className="muted">
            Document number <code>{order.invoice.invoiceNumber}</code>, issued for this order.
          </p>
        </section>
      )}

      <p>
        <Link href="/">Back to the store</Link>
      </p>
    </main>
  );
}
