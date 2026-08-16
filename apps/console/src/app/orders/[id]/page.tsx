import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@platform/core";
import { formatPaise } from "@platform/core/catalog";
import {
  MANUAL_ORDER_TRANSITIONS,
  ORDER_TRANSITIONS,
  canTransition,
  formatOrderNumber,
} from "@platform/core/orders";
import { getOrderDetail, getOrderNumberPrefix } from "@platform/core/orders/server";
import type { OrderDetailPayment } from "@platform/core/orders/server";

import { requireActor } from "../../../lib/session";
import { netSettlementPaise } from "../../../lib/settlement";
import { OrderActions } from "./OrderActions";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function label(status: string): string {
  return status.replaceAll("_", " ");
}

/**
 * Order detail: snapshot lines (never live catalog), payments with the
 * D17 net-settlement line, refunds, the order_events timeline (newest
 * first) and the manual-ladder action buttons. Buttons render ONLY from
 * ORDER_TRANSITIONS[current] ∩ MANUAL_ORDER_TRANSITIONS (D12) — the
 * server door is the wall, this page is convenience.
 */
export default async function OrderDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requireActor();
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  if (!can(actor, "orders:read")) {
    return (
      <main>
        <h1>Order</h1>
        <p className="error">Your role does not include access to orders.</p>
      </main>
    );
  }

  const [detail, prefix] = await Promise.all([
    getOrderDetail(actor.tenantId, id),
    getOrderNumberPrefix(actor.tenantId),
  ]);
  // Another tenant's order is invisible under RLS → plain 404.
  if (!detail) notFound();

  const orderLabel = formatOrderNumber(prefix, detail.orderNumber);
  const address = detail.shippingAddress;

  const nextStatuses = (ORDER_TRANSITIONS[detail.status] ?? []).filter((to) =>
    MANUAL_ORDER_TRANSITIONS.some((t) => t.from === detail.status && t.to === to),
  );
  const cancelLegal = canTransition(detail.status, "cancelled") && detail.status !== "pending_payment";

  return (
    <main>
      <nav className="crumbs">
        <Link href="/orders">Orders</Link> · {orderLabel}
      </nav>

      <h1>
        {orderLabel} <span className={`badge badge-${detail.status}`}>{label(detail.status)}</span>
      </h1>
      <p className="muted">
        Placed {detail.placedAt.toLocaleString("en-IN")} · {label(detail.channel)} ·{" "}
        {label(detail.paymentMode)} · payment {label(detail.paymentStatus)}
        {detail.cancelReason ? ` · cancelled: ${detail.cancelReason}` : ""}
      </p>

      <OrderActions
        orderId={detail.id}
        nextStatuses={[...nextStatuses]}
        canCancel={cancelLegal && can(actor, "orders:cancel")}
        canWrite={can(actor, "orders:write")}
      />

      <div className="panel">
        <h2>Buyer</h2>
        <p>
          {detail.buyerName} · {detail.buyerPhoneE164}
          {detail.buyerEmail ? ` · ${detail.buyerEmail}` : ""}
          {detail.buyerGstin ? (
            <>
              {" "}
              · GSTIN <code>{detail.buyerGstin}</code>
            </>
          ) : null}
        </p>
        <p className="muted">
          {[address.line1, address.line2, address.city, address.state_code, address.pincode]
            .filter((part) => typeof part === "string" && part)
            .join(", ")}
          {" · place of supply "}
          {detail.placeOfSupply}
        </p>
      </div>

      <div className="panel">
        <h2>Lines</h2>
        <table className="grid">
          <thead>
            <tr>
              <th>Item</th>
              <th>HSN</th>
              <th style={{ textAlign: "right" }}>Qty</th>
              <th style={{ textAlign: "right" }}>Unit price</th>
              <th style={{ textAlign: "right" }}>Discount</th>
              <th style={{ textAlign: "right" }}>Tax</th>
              <th style={{ textAlign: "right" }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {detail.lines.map((line) => (
              <tr key={line.id}>
                <td>
                  {line.titleSnapshot}
                  {line.skuSnapshot && (
                    <div className="muted">
                      <code>{line.skuSnapshot}</code>
                    </div>
                  )}
                </td>
                <td>{line.hsnSnapshot ?? <span className="muted">—</span>}</td>
                <td style={{ textAlign: "right" }}>{line.quantity}</td>
                <td style={{ textAlign: "right" }}>
                  {formatPaise(line.unitPricePaise, { currency: detail.currency })}
                </td>
                <td style={{ textAlign: "right" }}>
                  {line.discountPaise === 0 ? (
                    <span className="muted">—</span>
                  ) : (
                    formatPaise(line.discountPaise, { currency: detail.currency })
                  )}
                </td>
                <td style={{ textAlign: "right" }}>
                  {formatPaise(line.taxPaise, { currency: detail.currency })}
                  <div className="muted">{(line.taxRateBps / 100).toFixed(line.taxRateBps % 100 === 0 ? 0 : 2)}%</div>
                </td>
                <td style={{ textAlign: "right" }}>
                  {formatPaise(line.totalPaise, { currency: detail.currency })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <table className="grid" style={{ marginTop: 12 }}>
          <tbody>
            <Total label="Subtotal (items)" paise={detail.subtotalPaise} currency={detail.currency} />
            <Total label="Discount" paise={-detail.discountPaise} currency={detail.currency} hideZero />
            <Total label="Shipping" paise={detail.shippingPaise} currency={detail.currency} hideZero />
            <Total label="Tax (included)" paise={detail.taxPaise} currency={detail.currency} muted />
            <Total label="Total" paise={detail.totalPaise} currency={detail.currency} strong />
            <Total label="Paid" paise={detail.amountPaidPaise} currency={detail.currency} />
            <Total label="COD due" paise={detail.codDuePaise} currency={detail.currency} hideZero />
          </tbody>
        </table>

        {detail.couponCodeSnapshot && (
          <p className="muted">
            Coupon <code>{detail.couponCodeSnapshot}</code>
          </p>
        )}
      </div>

      <div className="panel">
        <h2>Payments</h2>
        {detail.payments.length === 0 ? (
          <p className="muted">No gateway payments{detail.paymentMode === "cod" ? " — cash on delivery" : ""}.</p>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Status</th>
                <th>Method</th>
                <th style={{ textAlign: "right" }}>Amount</th>
                <th style={{ textAlign: "right" }}>Net settlement</th>
              </tr>
            </thead>
            <tbody>
              {detail.payments.map((p) => (
                <tr key={p.id}>
                  <td>
                    {p.providerCode}
                    {p.gatewayPaymentId && (
                      <div className="muted">
                        <code>{p.gatewayPaymentId}</code>
                      </div>
                    )}
                  </td>
                  <td>
                    {label(p.status)}
                    {p.errorCode && <div className="error">{p.errorDescription ?? p.errorCode}</div>}
                  </td>
                  <td>{p.method ?? <span className="muted">—</span>}</td>
                  <td style={{ textAlign: "right" }}>
                    {formatPaise(p.amountPaise, { currency: detail.currency })}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <NetSettlement payment={p} currency={detail.currency} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {detail.refunds.length > 0 && (
          <>
            <h3>Refunds</h3>
            <table className="grid">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Status</th>
                  <th>Reason</th>
                  <th style={{ textAlign: "right" }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {detail.refunds.map((r) => (
                  <tr key={r.id}>
                    <td>{r.createdAt.toLocaleString("en-IN")}</td>
                    <td>{label(r.status)}</td>
                    <td>{label(r.reason)}</td>
                    <td style={{ textAlign: "right" }}>
                      {formatPaise(r.amountPaise, { currency: detail.currency })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      <div className="panel">
        <h2>Invoice</h2>
        {detail.invoice ? (
          <p>
            {detail.invoice.docType === "bill_of_supply" ? "Bill of Supply" : "Tax Invoice"}{" "}
            <code>{detail.invoice.invoiceNumber}</code> ·{" "}
            <Link href={`/orders/${detail.id}/invoice`} className="chip">
              View / print
            </Link>
          </p>
        ) : (
          <p className="muted">No invoice yet — one is issued at payment confirmation.</p>
        )}
      </div>

      <div className="panel">
        <h2>Timeline</h2>
        {detail.events.length === 0 ? (
          <p className="muted">No events recorded.</p>
        ) : (
          <table className="grid">
            <thead>
              <tr>
                <th>When</th>
                <th>Event</th>
                <th>Change</th>
                <th>Who</th>
              </tr>
            </thead>
            <tbody>
              {detail.events.map((e) => (
                <tr key={e.id}>
                  <td>{e.createdAt.toLocaleString("en-IN")}</td>
                  <td>
                    <code>{e.event}</code>
                  </td>
                  <td>
                    {e.fromStatus && e.toStatus ? (
                      <>
                        {label(e.fromStatus)} → {label(e.toStatus)}
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td>
                    {e.actorName ?? <span className="muted">{e.actorType}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </main>
  );
}

function Total({
  label: name,
  paise,
  currency,
  strong,
  muted,
  hideZero,
}: {
  label: string;
  paise: number;
  currency: string;
  strong?: boolean;
  muted?: boolean;
  hideZero?: boolean;
}) {
  if (hideZero && paise === 0) return null;
  const amount = formatPaise(paise, { currency });
  return (
    <tr className={muted ? "muted" : undefined}>
      <td>{strong ? <strong>{name}</strong> : name}</td>
      <td style={{ textAlign: "right" }}>{strong ? <strong>{amount}</strong> : amount}</td>
    </tr>
  );
}

/**
 * D17: net = gross − fee, what the gateway settles to the merchant.
 * Razorpay's `fee` already INCLUDES its GST (`tax` is the component
 * inside the fee, not an extra charge), so the GST renders as a
 * parenthetical of the fee and is never subtracted a second time —
 * see lib/settlement.ts.
 */
function NetSettlement({ payment, currency }: { payment: OrderDetailPayment; currency: string }) {
  const net = netSettlementPaise(payment);
  if (net === null || payment.feePaise === null) {
    return <span className="muted">—</span>;
  }
  const feeTax = payment.feeTaxPaise ?? 0;
  return (
    <>
      {formatPaise(net, { currency })}
      <div className="muted">
        Fee {formatPaise(payment.feePaise, { currency })}
        {feeTax > 0 && <> (incl. {formatPaise(feeTax, { currency })} GST)</>}
      </div>
    </>
  );
}
