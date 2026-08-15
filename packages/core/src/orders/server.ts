import { Queue } from "bullmq";

import {
  and,
  desc,
  eq,
  ilike,
  invoices,
  or,
  orderEvents,
  orderLines,
  orders,
  payments,
  refunds,
  sql,
  storeSettings,
  users,
  withTenant,
} from "@platform/db";
import type {
  ActorType,
  CheckoutPaymentMode,
  OrderChannel,
  OrderPaymentStatus,
  OrderStatus,
  PaymentStatus,
  RefundStatus,
  Tx,
} from "@platform/db";

import { recordAudit } from "../audit/index";
import type { WriteContext } from "../catalog/writes";
import { AppError } from "../errors";
import { QUEUE_NAMES, defaultJobOptions } from "../queues";
import { redis } from "../redis";
import {
  MANUAL_ORDER_TRANSITIONS,
  ORDER_NUMBER_PREFIX_KEY,
  assertTransition,
} from "./index";
import type { OrderDomainEvent, OrderEventName } from "./index";

/**
 * Orders — SERVER barrel. S0 SCHEMA SPINE: signatures FROZEN; bodies
 * implemented by lot B5. View-row shapes are lot-internal: B5 may ADD
 * fields but never remove or rename the ones frozen here.
 */

/**
 * Who is acting on the order. Confirmation (webhook) and expiry are
 * `system`, COD confirm is `customer`, manual transitions and cancel are
 * `staff` with an actorUserId. Tenant id comes from the session or the
 * resolved Host — never a payload.
 */
export type OrderActorContext = {
  tenantId: string;
  actorType: ActorType;
  actorUserId?: string | null;
  requestId?: string | null;
};

/**
 * What transitionOrder returns for post-commit enqueue: the order_events
 * row it inserted, ready to become the queue message (jobId =
 * orderEventId).
 */
export type OrderEventDescriptor = {
  orderEventId: string;
  tenantId: string;
  orderId: string;
  event: OrderEventName;
  /** ISO timestamp from the inserted order_events row. */
  occurredAt: string;
  requestId?: string | null;
  data?: Record<string, unknown>;
};

/**
 * THE one status write door (spec §5.1) — no route or module mutates
 * orders.status directly. Inside the CALLER's tx it (1) checks the
 * transition table → 422 `invalid_transition` with {from, to, allowed};
 * (2) UPDATE orders SET status .. WHERE status = <from> — 0 rows → 409
 * `concurrent_modification` (D21, on top of the caller's FOR UPDATE);
 * (3) INSERTs the order_events row; (4) returns the descriptor for
 * post-commit enqueue.
 *
 * Status-coupled timestamps live here so no caller forgets them:
 * `confirmed` sets confirmed_at and clears expires_at (§4.4f);
 * `cancelled` sets cancelled_at (§4.7). cancel_reason stays with the
 * cancel orchestration — it is input, not a consequence of the move.
 */
export async function transitionOrder(
  tx: Tx,
  ctx: OrderActorContext,
  order: { id: string; status: OrderStatus },
  to: OrderStatus,
  event: { name: OrderEventName; data?: Record<string, unknown> },
): Promise<OrderEventDescriptor> {
  assertTransition(order.status, to);

  const now = new Date();
  const [updated] = await tx
    .update(orders)
    .set({
      status: to,
      updatedAt: now,
      ...(to === "confirmed" ? { confirmedAt: now, expiresAt: null } : {}),
      ...(to === "cancelled" ? { cancelledAt: now } : {}),
    })
    .where(
      and(
        eq(orders.tenantId, ctx.tenantId),
        eq(orders.id, order.id),
        // The D21 belt: the row must still be where the caller saw it.
        eq(orders.status, order.status),
      ),
    )
    .returning({ id: orders.id });

  if (!updated) {
    throw new AppError({
      code: "concurrent_modification",
      message: `Order ${order.id} left status ${order.status} concurrently (wanted → ${to})`,
      status: 409,
      publicMessage: "This order was updated at the same time. Refresh and retry.",
    });
  }

  const [row] = await tx
    .insert(orderEvents)
    .values({
      tenantId: ctx.tenantId,
      orderId: order.id,
      event: event.name,
      fromStatus: order.status,
      toStatus: to,
      actorType: ctx.actorType,
      actorUserId: ctx.actorUserId ?? null,
      data: event.data ?? null,
      requestId: ctx.requestId ?? null,
    })
    .returning({ id: orderEvents.id, createdAt: orderEvents.createdAt });

  return {
    orderEventId: row!.id,
    tenantId: ctx.tenantId,
    orderId: order.id,
    event: event.name,
    occurredAt: row!.createdAt.toISOString(),
    requestId: ctx.requestId ?? null,
    ...(event.data === undefined ? {} : { data: event.data }),
  };
}

/**
 * Lazy, process-wide producer for the orders queue. Never constructed at
 * module scope: `next build` imports every route module to read its
 * config, and a Queue built at import time opens a Redis connection that
 * keeps the build alive (the console lib/queue.ts lesson). The shared
 * `redis()` client already carries BullMQ's required
 * `maxRetriesPerRequest: null`, and BullMQ will not close a client it
 * was handed.
 */
let ordersQueue: Queue<OrderDomainEvent> | undefined;

function getOrdersQueue(): Queue<OrderDomainEvent> {
  ordersQueue ??= new Queue<OrderDomainEvent>(QUEUE_NAMES.orders, {
    connection: redis(),
    defaultJobOptions,
  });
  return ordersQueue;
}

/**
 * Enqueue a committed order_events row onto the orders queue with
 * jobId = orderEventId (Redis-deduped, D11). AFTER commit only,
 * fail-soft — a lost enqueue loses a notification, never a fact.
 */
export async function enqueueOrderEvent(event: OrderEventDescriptor): Promise<void> {
  try {
    const message: OrderDomainEvent = {
      tenantId: event.tenantId,
      orderId: event.orderId,
      event: event.event,
      occurredAt: event.occurredAt,
      orderEventId: event.orderEventId,
      requestId: event.requestId ?? null,
      ...(event.data === undefined ? {} : { data: event.data }),
    };
    await getOrdersQueue().add(event.event, message, { jobId: event.orderEventId });
  } catch (err) {
    // The order_events row is the durable record; the queue message is
    // only delivery. Never let a Redis hiccup fail a committed write.
    console.error(
      JSON.stringify({
        level: "error",
        message: "order-event enqueue failed",
        tenantId: event.tenantId,
        orderId: event.orderId,
        orderEventId: event.orderEventId,
        event: event.event,
        error: String(err),
      }),
    );
  }
}

export type OrderListRow = {
  id: string;
  orderNumber: number;
  status: OrderStatus;
  paymentStatus: OrderPaymentStatus;
  paymentMode: CheckoutPaymentMode;
  channel: OrderChannel;
  buyerName: string;
  buyerPhoneE164: string;
  totalPaise: number;
  amountPaidPaise: number;
  codDuePaise: number;
  currency: string;
  placedAt: Date;
};

export async function listOrders(
  tenantId: string,
  opts: { status?: OrderStatus; q?: string; limit?: number; offset?: number } = {},
): Promise<{ items: OrderListRow[]; total: number }> {
  const limit = Math.min(opts.limit ?? 50, 100);
  const offset = Math.max(opts.offset ?? 0, 0);

  return withTenant(tenantId, async (tx) => {
    const conditions = [eq(orders.tenantId, tenantId)];
    if (opts.status) conditions.push(eq(orders.status, opts.status));

    const q = opts.q?.trim();
    if (q) {
      const like = `%${q}%`;
      // "ORD-1001" and "1001" both find order 1001; free text finds the
      // buyer by name or phone.
      const digits = q.replace(/^\D+/, "");
      conditions.push(
        or(
          ilike(orders.buyerName, like),
          ilike(orders.buyerPhoneE164, like),
          ...(digits ? [sql`${orders.orderNumber}::text = ${digits}`] : []),
        )!,
      );
    }

    const rows = await tx
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        status: orders.status,
        paymentStatus: orders.paymentStatus,
        paymentMode: orders.paymentMode,
        channel: orders.channel,
        buyerName: orders.buyerName,
        buyerPhoneE164: orders.buyerPhoneE164,
        totalPaise: orders.totalPaise,
        amountPaidPaise: orders.amountPaidPaise,
        codDuePaise: orders.codDuePaise,
        currency: orders.currency,
        placedAt: orders.placedAt,
        total: sql<number>`count(*) over ()::int`.as("total"),
      })
      .from(orders)
      .where(and(...conditions))
      .orderBy(desc(orders.placedAt), desc(orders.id))
      .limit(limit)
      .offset(offset);

    return {
      items: rows.map(({ total: _total, ...row }) => row),
      total: rows[0]?.total ?? 0,
    };
  });
}

/**
 * The merchant-facing order-number prefix (store_settings, 'ORD' when
 * unset). Pages pair it with the pure `formatOrderNumber`.
 */
export async function getOrderNumberPrefix(tenantId: string): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({ value: storeSettings.value })
      .from(storeSettings)
      .where(
        and(eq(storeSettings.tenantId, tenantId), eq(storeSettings.key, ORDER_NUMBER_PREFIX_KEY)),
      )
      .limit(1);
    return typeof row?.value === "string" && row.value.trim() ? row.value : "ORD";
  });
}

export type OrderDetailLine = {
  id: string;
  kind: "item" | "shipping";
  variantId: string | null;
  titleSnapshot: string;
  skuSnapshot: string;
  hsnSnapshot: string | null;
  quantity: number;
  unitPricePaise: number;
  discountPaise: number;
  taxablePaise: number;
  taxRateBps: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
  totalPaise: number;
  position: number;
};

export type OrderDetailPayment = {
  id: string;
  providerCode: string;
  status: PaymentStatus;
  amountPaise: number;
  gatewayOrderId: string | null;
  gatewayPaymentId: string | null;
  method: string | null;
  /** D17: console renders gross − fee − fee GST = net settlement. */
  feePaise: number | null;
  feeTaxPaise: number | null;
  errorCode: string | null;
  errorDescription: string | null;
  capturedAt: Date | null;
  createdAt: Date;
};

export type OrderDetailRefund = {
  id: string;
  paymentId: string;
  amountPaise: number;
  status: RefundStatus;
  reason: string;
  gatewayRefundId: string | null;
  createdAt: Date;
};

export type OrderTimelineEvent = {
  id: string;
  event: string;
  fromStatus: string | null;
  toStatus: string | null;
  actorType: ActorType;
  actorName: string | null;
  data: Record<string, unknown> | null;
  createdAt: Date;
};

export type OrderDetail = OrderListRow & {
  fulfilmentStatus: string;
  buyerEmail: string | null;
  shippingAddress: Record<string, unknown>;
  placeOfSupply: string;
  buyerGstin: string | null;
  subtotalPaise: number;
  discountPaise: number;
  shippingPaise: number;
  taxPaise: number;
  couponCodeSnapshot: string | null;
  cancelReason: string | null;
  confirmedAt: Date | null;
  cancelledAt: Date | null;
  expiresAt: Date | null;
  lines: OrderDetailLine[];
  payments: OrderDetailPayment[];
  refunds: OrderDetailRefund[];
  events: OrderTimelineEvent[];
  /** Invoice reference, when issued. */
  invoice: { id: string; invoiceNumber: string; docType: string } | null;
};

export async function getOrderDetail(
  tenantId: string,
  orderId: string,
): Promise<OrderDetail | null> {
  return withTenant(tenantId, async (tx) => {
    const [order] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), eq(orders.id, orderId)))
      .limit(1);
    if (!order) return null;

    const lines = await tx
      .select({
        id: orderLines.id,
        kind: orderLines.kind,
        variantId: orderLines.variantId,
        titleSnapshot: orderLines.titleSnapshot,
        skuSnapshot: orderLines.skuSnapshot,
        hsnSnapshot: orderLines.hsnSnapshot,
        quantity: orderLines.quantity,
        unitPricePaise: orderLines.unitPricePaise,
        discountPaise: orderLines.discountPaise,
        taxablePaise: orderLines.taxablePaise,
        taxRateBps: orderLines.taxRateBps,
        cgstPaise: orderLines.cgstPaise,
        sgstPaise: orderLines.sgstPaise,
        igstPaise: orderLines.igstPaise,
        taxPaise: orderLines.taxPaise,
        totalPaise: orderLines.totalPaise,
        position: orderLines.position,
      })
      .from(orderLines)
      .where(eq(orderLines.orderId, orderId))
      .orderBy(orderLines.position, orderLines.id);

    const paymentRows = await tx
      .select({
        id: payments.id,
        providerCode: payments.providerCode,
        status: payments.status,
        amountPaise: payments.amountPaise,
        gatewayOrderId: payments.gatewayOrderId,
        gatewayPaymentId: payments.gatewayPaymentId,
        method: payments.method,
        feePaise: payments.feePaise,
        feeTaxPaise: payments.feeTaxPaise,
        errorCode: payments.errorCode,
        errorDescription: payments.errorDescription,
        capturedAt: payments.capturedAt,
        createdAt: payments.createdAt,
      })
      .from(payments)
      .where(eq(payments.orderId, orderId))
      .orderBy(payments.createdAt, payments.id);

    const refundRows = await tx
      .select({
        id: refunds.id,
        paymentId: refunds.paymentId,
        amountPaise: refunds.amountPaise,
        status: refunds.status,
        reason: refunds.reason,
        gatewayRefundId: refunds.gatewayRefundId,
        createdAt: refunds.createdAt,
      })
      .from(refunds)
      .where(eq(refunds.orderId, orderId))
      .orderBy(refunds.createdAt, refunds.id);

    // Newest first — the timeline reads top-down as "what just happened".
    // `users` is control-plane (no RLS), so the join resolves.
    const eventRows = await tx
      .select({
        id: orderEvents.id,
        event: orderEvents.event,
        fromStatus: orderEvents.fromStatus,
        toStatus: orderEvents.toStatus,
        actorType: orderEvents.actorType,
        actorName: users.name,
        data: orderEvents.data,
        createdAt: orderEvents.createdAt,
      })
      .from(orderEvents)
      .leftJoin(users, eq(users.id, orderEvents.actorUserId))
      .where(eq(orderEvents.orderId, orderId))
      .orderBy(desc(orderEvents.createdAt), desc(orderEvents.id));

    const [invoice] = await tx
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        docType: invoices.docType,
      })
      .from(invoices)
      .where(eq(invoices.orderId, orderId))
      .limit(1);

    return {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      paymentStatus: order.paymentStatus,
      paymentMode: order.paymentMode,
      channel: order.channel,
      buyerName: order.buyerName,
      buyerPhoneE164: order.buyerPhoneE164,
      totalPaise: order.totalPaise,
      amountPaidPaise: order.amountPaidPaise,
      codDuePaise: order.codDuePaise,
      currency: order.currency,
      placedAt: order.placedAt,
      fulfilmentStatus: order.fulfilmentStatus,
      buyerEmail: order.buyerEmail,
      shippingAddress: (order.shippingAddress ?? {}) as Record<string, unknown>,
      placeOfSupply: order.placeOfSupply,
      buyerGstin: order.buyerGstin,
      subtotalPaise: order.subtotalPaise,
      discountPaise: order.discountPaise,
      shippingPaise: order.shippingPaise,
      taxPaise: order.taxPaise,
      couponCodeSnapshot: order.couponCodeSnapshot,
      cancelReason: order.cancelReason,
      confirmedAt: order.confirmedAt,
      cancelledAt: order.cancelledAt,
      expiresAt: order.expiresAt,
      lines,
      payments: paymentRows,
      refunds: refundRows,
      events: eventRows.map((e) => ({
        ...e,
        data: (e.data ?? null) as Record<string, unknown> | null,
      })),
      invoice: invoice ?? null,
    };
  });
}

/** Forward-ladder event names, keyed by the manual target status (§5.2). */
const MANUAL_EVENT_BY_TARGET: Partial<Record<OrderStatus, OrderEventName>> = {
  processing: "order.processing",
  ready_to_ship: "order.ready_to_ship",
  shipped: "order.shipped",
  out_for_delivery: "order.out_for_delivery",
  delivered: "order.delivered",
};

/**
 * Console entry point for the manual fulfilment ladder (D12/§4.8): FOR
 * UPDATE, MANUAL_ORDER_TRANSITIONS allowlist, transitionOrder, audit —
 * one tx; enqueue after commit. `delivered` on a COD order sets
 * payment_status = 'paid' and amount_paid = total.
 */
export async function manualTransition(
  ctx: WriteContext,
  orderId: string,
  to: OrderStatus,
): Promise<OrderEventDescriptor> {
  const descriptor = await withTenant(ctx.tenantId, async (tx) => {
    const [order] = await tx
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        status: orders.status,
        paymentMode: orders.paymentMode,
        paymentStatus: orders.paymentStatus,
        totalPaise: orders.totalPaise,
        amountPaidPaise: orders.amountPaidPaise,
      })
      .from(orders)
      .where(and(eq(orders.tenantId, ctx.tenantId), eq(orders.id, orderId)))
      .limit(1)
      .for("update");

    if (!order) {
      throw new AppError({
        code: "not_found",
        message: `Order ${orderId} not found in this tenant`,
        status: 404,
        publicMessage: "That order does not exist.",
      });
    }

    // The staff allowlist is the wall (D12): RTO/return edges exist in
    // ORDER_TRANSITIONS but have no writer, and cancel goes through its
    // own route/permission — none of them pass here.
    const eventName = MANUAL_EVENT_BY_TARGET[to];
    const allowed = MANUAL_ORDER_TRANSITIONS.some((t) => t.from === order.status && t.to === to);
    if (!allowed || !eventName) {
      const allowedTargets = MANUAL_ORDER_TRANSITIONS.filter((t) => t.from === order.status).map(
        (t) => t.to,
      );
      throw new AppError({
        code: "invalid_transition",
        message: `Manual transition ${order.status} → ${to} refused for order ${orderId}`,
        status: 422,
        publicMessage: `An order that is ${order.status.replaceAll("_", " ")} cannot be moved to ${to.replaceAll("_", " ")} from the console.`,
        details: { from: order.status, to, allowed: allowedTargets },
      });
    }

    // §4.8: delivering a COD (or advance-COD) order collects the balance
    // at the doorstep — assumed, reconciliation is Phase 3.
    const collectsCod =
      to === "delivered" && order.paymentMode !== "prepaid" && order.paymentStatus !== "paid";

    const event = await transitionOrder(
      tx,
      {
        tenantId: ctx.tenantId,
        actorType: "staff",
        actorUserId: ctx.actorUserId,
        requestId: ctx.requestId,
      },
      { id: order.id, status: order.status },
      to,
      {
        name: eventName,
        data: {
          orderNumber: order.orderNumber,
          ...(collectsCod
            ? { codCollectedPaise: order.totalPaise - order.amountPaidPaise }
            : {}),
        },
      },
    );

    if (collectsCod) {
      await tx
        .update(orders)
        .set({
          paymentStatus: "paid",
          amountPaidPaise: order.totalPaise,
          codDuePaise: 0,
          updatedAt: new Date(),
        })
        .where(and(eq(orders.tenantId, ctx.tenantId), eq(orders.id, orderId)));
    }

    await recordAudit(tx, ctx.tenantId, {
      actorType: "staff",
      actorUserId: ctx.actorUserId,
      action: "order.status_changed",
      entityType: "order",
      entityId: orderId,
      before: {
        status: order.status,
        ...(collectsCod
          ? { paymentStatus: order.paymentStatus, amountPaidPaise: order.amountPaidPaise }
          : {}),
      },
      after: {
        status: to,
        ...(collectsCod ? { paymentStatus: "paid", amountPaidPaise: order.totalPaise } : {}),
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });

    return event;
  });

  // After the commit, never inside it. Fail-soft (D11).
  await enqueueOrderEvent(descriptor);
  return descriptor;
}
