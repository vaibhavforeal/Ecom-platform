import {
  and,
  couponRedemptions,
  desc,
  eq,
  orders,
  promotions,
  sql,
  withTenant,
} from "@platform/db";
import type { PromotionStatus, Tx } from "@platform/db";

import { recordAudit } from "../audit/index";
import type { WriteContext } from "../catalog/writes";
import { AppError, NotFoundError } from "../errors";
import { PROMOTION_STATUSES, conditionSchema, effectSchema } from "./index";
import type { Condition, Effect, PromotionData } from "./index";

/**
 * Promotions — SERVER barrel.
 *
 * Locked rules: limits are enforced by the coupon_redemptions unique
 * constraints, NEVER a counter; the promotion row is SELECTed FOR UPDATE
 * before any slot computation (D8); pending-claim counting keeps the
 * `expires_at > now()` read-side filter exactly like holds; 23505 on the
 * slot indexes maps to 409 `concurrent_modification`.
 */

export type PromotionInput = {
  /** Uppercased at write; /^[A-Z0-9_-]{3,40}$/i at the route. */
  code: string;
  name: string;
  status: PromotionStatus;
  startsAt?: Date | null;
  endsAt?: Date | null;
  /** zod-validated (conditionSchema/effectSchema) before write. */
  conditions: Condition[];
  effects: Effect[];
  usageLimitTotal?: number | null;
  usageLimitPerCustomer?: number | null;
};

const CODE_RE = /^[A-Z0-9_-]{3,40}$/;
const USAGE_LIMIT_MAX = 1_000_000;

/** Walks err.cause chains for the root Postgres error code / text. */
function pgError(err: unknown): { code?: string; text: string } {
  let code: string | undefined;
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 6 && cur; i++) {
    const c = (cur as { code?: unknown }).code;
    if (!code && typeof c === "string") code = c;
    parts.push(String((cur as Error).message ?? cur));
    cur = (cur as { cause?: unknown }).cause;
  }
  return { code, text: parts.join(" ⇐ ") };
}

type Issue = { path: string; message: string };

function invalidPayload(issues: Issue[]): never {
  throw new AppError({
    code: "invalid_payload",
    message: `Promotion payload invalid: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
    status: 422,
    publicMessage: "Some fields need attention.",
    details: { issues },
  });
}

type CleanPromotionInput = {
  code: string;
  name: string;
  status: PromotionStatus;
  startsAt: Date | null;
  endsAt: Date | null;
  conditions: Condition[];
  effects: Effect[];
  usageLimitTotal: number | null;
  usageLimitPerCustomer: number | null;
};

/**
 * Cheap invariants BEFORE any transaction (write-door recipe step 2).
 * Conditions/effects go through the SAME zod unions the route uses —
 * the domain door revalidates because integration callers reach it
 * without the route — and the PARSED value is what gets stored, so
 * unknown keys in hostile JSON never land in the jsonb column.
 */
function validatePromotionInput(input: PromotionInput): CleanPromotionInput {
  const issues: Issue[] = [];

  const code = input.code.trim().toUpperCase();
  if (!CODE_RE.test(code)) {
    issues.push({ path: "code", message: "Use 3–40 letters, digits, _ or -." });
  }
  const name = input.name.trim();
  if (name.length < 1 || name.length > 120) {
    issues.push({ path: "name", message: "Enter a name up to 120 characters." });
  }
  if (!PROMOTION_STATUSES.includes(input.status)) {
    issues.push({ path: "status", message: "Unknown status." });
  }

  const startsAt = input.startsAt ?? null;
  const endsAt = input.endsAt ?? null;
  if (startsAt && endsAt && startsAt.getTime() >= endsAt.getTime()) {
    issues.push({ path: "endsAt", message: "The end must come after the start." });
  }

  const conditions: Condition[] = [];
  if (input.conditions.length > 20) {
    issues.push({ path: "conditions", message: "At most 20 conditions." });
  } else {
    input.conditions.forEach((condition, i) => {
      const parsed = conditionSchema.safeParse(condition);
      if (parsed.success) conditions.push(parsed.data);
      else {
        const first = parsed.error.issues[0];
        issues.push({
          path: `conditions.${i}`,
          message: first ? `${first.path.join(".") || "condition"}: ${first.message}` : "Invalid condition.",
        });
      }
    });
  }

  const effects: Effect[] = [];
  if (input.effects.length < 1) {
    issues.push({ path: "effects", message: "At least one effect is required." });
  } else if (input.effects.length > 10) {
    issues.push({ path: "effects", message: "At most 10 effects." });
  } else {
    input.effects.forEach((effect, i) => {
      const parsed = effectSchema.safeParse(effect);
      if (parsed.success) effects.push(parsed.data);
      else {
        const first = parsed.error.issues[0];
        issues.push({
          path: `effects.${i}`,
          message: first ? `${first.path.join(".") || "effect"}: ${first.message}` : "Invalid effect.",
        });
      }
    });
  }

  const limit = (value: number | null | undefined, path: string): number | null => {
    if (value === null || value === undefined) return null;
    if (!Number.isInteger(value) || value < 1 || value > USAGE_LIMIT_MAX) {
      issues.push({ path, message: "Enter a whole number of at least 1, or leave unlimited." });
      return null;
    }
    return value;
  };
  const usageLimitTotal = limit(input.usageLimitTotal, "usageLimitTotal");
  const usageLimitPerCustomer = limit(input.usageLimitPerCustomer, "usageLimitPerCustomer");

  if (issues.length > 0) invalidPayload(issues);

  return {
    code,
    name,
    status: input.status,
    startsAt,
    endsAt,
    conditions,
    effects,
    usageLimitTotal,
    usageLimitPerCustomer,
  };
}

type PromotionRow = typeof promotions.$inferSelect;

function toPromotionData(row: PromotionRow): PromotionData {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    conditions: row.conditions as Condition[],
    effects: row.effects as Effect[],
    usageLimitTotal: row.usageLimitTotal,
    usageLimitPerCustomer: row.usageLimitPerCustomer,
  };
}

/** Audit snapshot: the merchant-editable representation, not the raw row. */
function auditShape(data: PromotionData): Record<string, unknown> {
  return {
    code: data.code,
    name: data.name,
    status: data.status,
    startsAt: data.startsAt?.toISOString() ?? null,
    endsAt: data.endsAt?.toISOString() ?? null,
    conditions: data.conditions,
    effects: data.effects,
    usageLimitTotal: data.usageLimitTotal,
    usageLimitPerCustomer: data.usageLimitPerCustomer,
  };
}

/** 23505 on the tenant+code unique → a form-shaped 422, not a 500. */
function mapWriteError(err: unknown): never {
  const pg = pgError(err);
  if (pg.code === "23505" && pg.text.includes("promotions_tenant_code_key")) {
    throw new AppError({
      code: "duplicate_code",
      message: "A promotion with this code already exists in this tenant",
      status: 422,
      publicMessage: "That code is already in use.",
      details: { issues: [{ path: "code", message: "Another promotion already uses this code." }] },
    });
  }
  throw err;
}

export async function createPromotion(
  ctx: WriteContext,
  input: PromotionInput,
): Promise<PromotionData> {
  const clean = validatePromotionInput(input);
  try {
    return await withTenant(ctx.tenantId, async (tx) => {
      const [row] = await tx
        .insert(promotions)
        .values({
          tenantId: ctx.tenantId,
          code: clean.code,
          name: clean.name,
          status: clean.status,
          startsAt: clean.startsAt,
          endsAt: clean.endsAt,
          conditions: clean.conditions,
          effects: clean.effects,
          usageLimitTotal: clean.usageLimitTotal,
          usageLimitPerCustomer: clean.usageLimitPerCustomer,
          updatedByUserId: ctx.actorUserId,
        })
        .returning();
      const data = toPromotionData(row!);

      await recordAudit(tx, ctx.tenantId, {
        actorType: "staff",
        actorUserId: ctx.actorUserId,
        action: "promotion.created",
        entityType: "promotion",
        entityId: data.id,
        before: null,
        after: auditShape(data),
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });

      return data;
    });
  } catch (err) {
    mapWriteError(err);
  }
}

export async function updatePromotion(
  ctx: WriteContext,
  promotionId: string,
  input: PromotionInput,
): Promise<PromotionData> {
  const clean = validatePromotionInput(input);
  try {
    return await withTenant(ctx.tenantId, async (tx) => {
      // FOR UPDATE so the audit's before/after pair is exact under a
      // concurrent edit (visibility SELECT — FKs do not enforce tenancy).
      const [existing] = await tx
        .select()
        .from(promotions)
        .where(and(eq(promotions.tenantId, ctx.tenantId), eq(promotions.id, promotionId)))
        .limit(1)
        .for("update");
      if (!existing) throw new NotFoundError("Promotion");
      const before = toPromotionData(existing);

      const [row] = await tx
        .update(promotions)
        .set({
          code: clean.code,
          name: clean.name,
          status: clean.status,
          startsAt: clean.startsAt,
          endsAt: clean.endsAt,
          conditions: clean.conditions,
          effects: clean.effects,
          usageLimitTotal: clean.usageLimitTotal,
          usageLimitPerCustomer: clean.usageLimitPerCustomer,
          updatedAt: new Date(),
          updatedByUserId: ctx.actorUserId,
        })
        .where(and(eq(promotions.tenantId, ctx.tenantId), eq(promotions.id, promotionId)))
        .returning();
      const data = toPromotionData(row!);

      await recordAudit(tx, ctx.tenantId, {
        actorType: "staff",
        actorUserId: ctx.actorUserId,
        action: "promotion.updated",
        entityType: "promotion",
        entityId: data.id,
        before: auditShape(before),
        after: auditShape(data),
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });

      return data;
    });
  } catch (err) {
    mapWriteError(err);
  }
}

/** DELETE archives — promotions referenced by orders are never erased. */
export async function archivePromotion(ctx: WriteContext, promotionId: string): Promise<void> {
  await withTenant(ctx.tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(promotions)
      .where(and(eq(promotions.tenantId, ctx.tenantId), eq(promotions.id, promotionId)))
      .limit(1)
      .for("update");
    if (!existing) throw new NotFoundError("Promotion");
    if (existing.status === "archived") return; // idempotent

    await tx
      .update(promotions)
      .set({ status: "archived", updatedAt: new Date(), updatedByUserId: ctx.actorUserId })
      .where(and(eq(promotions.tenantId, ctx.tenantId), eq(promotions.id, promotionId)));

    await recordAudit(tx, ctx.tenantId, {
      actorType: "staff",
      actorUserId: ctx.actorUserId,
      action: "promotion.archived",
      entityType: "promotion",
      entityId: promotionId,
      before: { status: existing.status },
      after: { status: "archived" },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      requestId: ctx.requestId,
    });
  });
}

export async function listPromotions(
  tenantId: string,
  opts: { status?: PromotionStatus; limit?: number; offset?: number } = {},
): Promise<{ items: PromotionData[]; total: number }> {
  const limit = Math.min(opts.limit ?? 50, 100);
  const offset = Math.max(opts.offset ?? 0, 0);

  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({
        row: promotions,
        total: sql<number>`count(*) over ()::int`.as("total"),
      })
      .from(promotions)
      .where(
        and(
          eq(promotions.tenantId, tenantId),
          opts.status ? eq(promotions.status, opts.status) : undefined,
        ),
      )
      .orderBy(desc(promotions.createdAt), desc(promotions.id))
      .limit(limit)
      .offset(offset);

    return {
      items: rows.map((r) => toPromotionData(r.row)),
      total: rows[0]?.total ?? 0,
    };
  });
}

export async function getPromotion(
  tenantId: string,
  promotionId: string,
): Promise<PromotionData | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(promotions)
      .where(and(eq(promotions.tenantId, tenantId), eq(promotions.id, promotionId)))
      .limit(1);
    return row ? toPromotionData(row) : null;
  });
}

/**
 * SELECT .. FOR UPDATE by uppercased code, status='active' (D8): the
 * lock serializes BOTH the checkout-start advisory count and the confirm
 * slot computation. Null when absent/inactive.
 */
export async function loadActivePromotionForUpdate(
  tx: Tx,
  tenantId: string,
  code: string,
): Promise<PromotionData | null> {
  const [row] = await tx
    .select()
    .from(promotions)
    .where(
      and(
        eq(promotions.tenantId, tenantId),
        eq(promotions.code, code.trim().toUpperCase()),
        eq(promotions.status, "active"),
      ),
    )
    .limit(1)
    .for("update");
  return row ? toPromotionData(row) : null;
}

async function countRedemptionRows(
  tx: Tx,
  tenantId: string,
  promotionId: string,
  customerId?: string,
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int`.as("n") })
    .from(couponRedemptions)
    .where(
      and(
        eq(couponRedemptions.tenantId, tenantId),
        eq(couponRedemptions.promotionId, promotionId),
        customerId ? eq(couponRedemptions.customerId, customerId) : undefined,
      ),
    );
  return row?.n ?? 0;
}

/**
 * Redemption rows so far, inside the caller's tx. The checkout-start
 * advisory (§4.2) is `countRedemptions + countPendingClaims` vs
 * `usageLimitTotal`, computed under `loadActivePromotionForUpdate`'s
 * lock.
 */
export async function countRedemptions(
  tx: Tx,
  tenantId: string,
  promotionId: string,
): Promise<number> {
  return countRedemptionRows(tx, tenantId, promotionId);
}

/**
 * Slot mechanics inside the CALLER's confirming tx (§1.8): with the
 * promotion row already locked, slot = COUNT(*) rows, customer_slot =
 * COUNT(*) for (promotion, customer); at a limit → {claimed:false} —
 * the CALLER decides between 422 coupon_exhausted (checkout) and
 * confirm-anyway + `promotion.overredeemed` (captured money, §4.4.h).
 * A racer past the count collides on the unique index → 23505 → 409.
 */
export async function claimRedemption(
  tx: Tx,
  tenantId: string,
  input: {
    promotion: PromotionData;
    orderId: string;
    customerId: string | null;
    discountPaise: number;
  },
): Promise<
  | { claimed: true; redemptionId: string; slot: number; customerSlot: number }
  | { claimed: false; reason: "coupon_exhausted" }
> {
  if (!Number.isInteger(input.discountPaise) || input.discountPaise < 0) {
    invalidPayload([{ path: "discountPaise", message: "Enter a non-negative whole amount." }]);
  }

  // Defensive re-lock (free when the caller already holds it, D8): the
  // slot COUNTs below are only race-safe under the promotion row's lock.
  await tx
    .select({ id: promotions.id })
    .from(promotions)
    .where(and(eq(promotions.tenantId, tenantId), eq(promotions.id, input.promotion.id)))
    .limit(1)
    .for("update");

  // Replay fast-path: cr_promo_order_key means one redemption per order,
  // so a webhook redelivery returns the original claim, not a new slot.
  const [existing] = await tx
    .select({
      id: couponRedemptions.id,
      slot: couponRedemptions.slot,
      customerSlot: couponRedemptions.customerSlot,
    })
    .from(couponRedemptions)
    .where(
      and(
        eq(couponRedemptions.tenantId, tenantId),
        eq(couponRedemptions.promotionId, input.promotion.id),
        eq(couponRedemptions.orderId, input.orderId),
      ),
    )
    .limit(1);
  if (existing) {
    return {
      claimed: true,
      redemptionId: existing.id,
      slot: existing.slot,
      customerSlot: existing.customerSlot,
    };
  }

  const slot = await countRedemptionRows(tx, tenantId, input.promotion.id);
  if (input.promotion.usageLimitTotal !== null && slot >= input.promotion.usageLimitTotal) {
    return { claimed: false, reason: "coupon_exhausted" };
  }

  let customerSlot = 0;
  if (input.customerId !== null) {
    customerSlot = await countRedemptionRows(tx, tenantId, input.promotion.id, input.customerId);
    if (
      input.promotion.usageLimitPerCustomer !== null &&
      customerSlot >= input.promotion.usageLimitPerCustomer
    ) {
      return { claimed: false, reason: "coupon_exhausted" };
    }
  }

  try {
    const [row] = await tx
      .insert(couponRedemptions)
      .values({
        tenantId,
        promotionId: input.promotion.id,
        orderId: input.orderId,
        customerId: input.customerId,
        slot,
        customerSlot,
        discountPaise: input.discountPaise,
      })
      .returning({ id: couponRedemptions.id });
    return { claimed: true, redemptionId: row!.id, slot, customerSlot };
  } catch (err) {
    // A racer that slipped past the counts collided on a slot index. The
    // caller's tx is aborted; 409 tells it to retry the whole confirm.
    const pg = pgError(err);
    if (pg.code === "23505" && pg.text.includes("cr_promo_")) {
      throw new AppError({
        code: "concurrent_modification",
        message: "Another redemption claimed this slot concurrently",
        status: 409,
        publicMessage: "This coupon was redeemed at the same time by another order. Please retry.",
      });
    }
    throw err;
  }
}

/**
 * Advisory pending-claim count for checkout-start (D8): pending_payment
 * orders carrying this promotion_id with expires_at > now() — the
 * read-side expiry filter is NON-NEGOTIABLE.
 */
export async function countPendingClaims(
  tx: Tx,
  tenantId: string,
  promotionId: string,
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int`.as("n") })
    .from(orders)
    .where(
      and(
        eq(orders.tenantId, tenantId),
        eq(orders.promotionId, promotionId),
        eq(orders.status, "pending_payment"),
        sql`${orders.expiresAt} > now()`,
      ),
    );
  return row?.n ?? 0;
}
