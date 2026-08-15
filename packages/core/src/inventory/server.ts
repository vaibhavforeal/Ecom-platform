import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  locations,
  products,
  productVariants,
  sql,
  stockLevels,
  stockMovements,
  stockReservations,
  users,
  withTenant,
} from "@platform/db";
import type { StockMovementReason, Tx } from "@platform/db";

import { recordAudit } from "../audit/index";
import { catalogPurgeTags } from "../catalog/cache-tags";
import { purgeStorefrontCache } from "../catalog/purge";
import type { WriteContext } from "../catalog/writes";
import { AppError } from "../errors";
import { RESERVATION_TTL_MINUTES, STOCK_ADJUSTMENT_MAX } from "./index";
import type { ConsumeLineResult, HoldLineInput, HoldLineResult, ReservationReference } from "./index";

/**
 * The inventory ledger's single write door. SERVER ONLY.
 *
 * Blueprint §4.5: stock_movements is the source of truth,
 * stock_levels the projection — kept true HERE, in the same transaction
 * as the ledger insert, never by a second writer. The projection's
 * CHECK (on_hand >= 0) makes oversell a database impossibility: two
 * concurrent movements serialize on the projection row's lock and the
 * loser of a last-unit race gets a constraint violation this module
 * turns into a 422.
 *
 * Every entry point opens its own withTenant; the tenant id comes from
 * the caller's SESSION, never a payload. The variant is looked up with
 * an explicit SELECT first (the FK-does-not-enforce-tenancy trap — and
 * the ledger deliberately has no variant FK at all).
 */

export class VariantNotFoundError extends AppError {
  constructor(variantId: string) {
    super({
      code: "not_found",
      message: `Variant ${variantId} not found in this tenant`,
      status: 404,
      publicMessage: "That variant does not exist.",
    });
  }
}

export class UntrackedVariantError extends AppError {
  constructor(variantId: string) {
    super({
      code: "untracked_variant",
      message: `Variant ${variantId} does not track inventory`,
      status: 422,
      publicMessage: "Turn on inventory tracking for this variant before adjusting its stock.",
      details: {
        issues: [{ path: "variantId", message: "This variant does not track inventory." }],
      },
    });
  }
}

export class InsufficientStockError extends AppError {
  constructor(onHand: number, delta: number) {
    super({
      code: "insufficient_stock",
      message: `Movement of ${delta} refused: on-hand is ${onHand}`,
      status: 422,
      publicMessage: `That change would take stock below zero (on hand: ${onHand}).`,
      details: {
        issues: [{ path: "delta", message: `On hand is ${onHand}; stock cannot go below zero.` }],
      },
    });
  }
}

export class StockHeldError extends AppError {
  constructor(resultingOnHand: number, reserved: number, soonestExpiry: Date | null) {
    super({
      code: "stock_held",
      message: `Movement refused: on-hand would be ${resultingOnHand} with ${reserved} held by active checkouts (soonest expiry ${soonestExpiry?.toISOString() ?? "unknown"})`,
      status: 422,
      publicMessage: `Buyers are checking out with ${reserved} of these right now; stock cannot drop below what is held. Holds expire within 15 minutes.`,
      details: {
        issues: [
          { path: "delta", message: `${reserved} held by active checkouts — retry after the holds expire.` },
        ],
      },
    });
  }
}

export type MovementInput = {
  variantId: string;
  delta: number;
  note?: string | null;
  idempotencyKey?: string | null;
};

export type MovementResult = {
  movementId: string;
  variantId: string;
  productId: string;
  reason: StockMovementReason;
  delta: number;
  onHand: number;
  replayed: boolean;
};

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

/**
 * Get-or-create the tenant's default location, inside the caller's
 * transaction. Race-safe via locations_one_default_key: the loser of a
 * concurrent create re-selects the winner's row.
 */
export async function ensureDefaultLocation(
  tx: Tx,
  tenantId: string,
): Promise<{ id: string }> {
  const select = () =>
    tx
      .select({ id: locations.id })
      .from(locations)
      .where(and(eq(locations.tenantId, tenantId), eq(locations.isDefault, true)))
      .limit(1);

  const [existing] = await select();
  if (existing) return existing;

  const [created] = await tx
    .insert(locations)
    .values({ tenantId, name: "Default", isDefault: true })
    .onConflictDoNothing()
    .returning({ id: locations.id });
  if (created) return created;

  const [raced] = await select();
  if (!raced) throw new Error(`Default location for ${tenantId} neither created nor found`);
  return raced;
}

async function findByIdempotencyKey(
  tx: Tx,
  tenantId: string,
  key: string,
): Promise<Omit<MovementResult, "replayed"> | null> {
  const [movement] = await tx
    .select({
      movementId: stockMovements.id,
      variantId: stockMovements.variantId,
      reason: stockMovements.reason,
      delta: stockMovements.delta,
    })
    .from(stockMovements)
    .where(and(eq(stockMovements.tenantId, tenantId), eq(stockMovements.idempotencyKey, key)))
    .limit(1);
  if (!movement) return null;

  const [variant] = await tx
    .select({ productId: productVariants.productId })
    .from(productVariants)
    .where(eq(productVariants.id, movement.variantId))
    .limit(1);

  const levels = await getStockLevels(tx, [movement.variantId]);
  return {
    ...movement,
    productId: variant?.productId ?? "",
    onHand: levels.get(movement.variantId) ?? 0,
  };
}

type ApplyMovementArgs = {
  tenantId: string;
  variantId: string;
  productId: string;
  locationId: string;
  delta: number;
  reason: StockMovementReason;
  note: string | null;
  idempotencyKey: string | null;
  createdByUserId: string | null;
  referenceType: string | null;
  referenceId: string | null;
};

/**
 * The ledger insert + projection write, inside the CALLER's transaction.
 * Shared by recordMovement (adjustments) and consumeStock (sales) — the
 * only two writers. Throws raw Postgres errors (callers map them) and
 * StockHeldError.
 *
 * Phase 5 assumption: one location per variant, so if a prior movement
 * exists, the projection row exists. Phase 5 (multi-location) must revisit:
 * the reason check is per-variant, the projection key per-(variant,location).
 */
async function applyMovement(
  tx: Tx,
  args: ApplyMovementArgs,
): Promise<{ movementId: string; onHand: number }> {
  const [movement] = await tx
    .insert(stockMovements)
    .values({
      tenantId: args.tenantId,
      variantId: args.variantId,
      locationId: args.locationId,
      delta: args.delta,
      reason: args.reason,
      note: args.note,
      idempotencyKey: args.idempotencyKey,
      createdByUserId: args.createdByUserId,
      referenceType: args.referenceType,
      referenceId: args.referenceId,
    })
    .returning({ id: stockMovements.id });

  // Projection: UPDATE first, INSERT when no row exists yet. Branches on
  // ROW EXISTENCE, not reason — with `sale` in the enum, "reason ===
  // opening_balance" stopped meaning "first write". UPDATE-first also
  // keeps negative values away from the CHECK-on-INSERT-tuple trap, and
  // two concurrent first movements still collide on the projection PK
  // (both see no row, both INSERT) — the caller maps that 23505 to 409.
  let onHand: number;
  const [updated] = await tx
    .update(stockLevels)
    .set({ onHand: sql`${stockLevels.onHand} + ${args.delta}`, updatedAt: new Date() })
    .where(
      and(
        eq(stockLevels.tenantId, args.tenantId),
        eq(stockLevels.variantId, args.variantId),
        eq(stockLevels.locationId, args.locationId),
      ),
    )
    .returning({ onHand: stockLevels.onHand });
  if (updated) {
    onHand = updated.onHand;
  } else {
    const [inserted] = await tx
      .insert(stockLevels)
      .values({
        tenantId: args.tenantId,
        variantId: args.variantId,
        locationId: args.locationId,
        onHand: args.delta,
      })
      .returning({ onHand: stockLevels.onHand });
    onHand = inserted!.onHand;
  }

  // A negative movement must not take on-hand below what active
  // checkouts hold — a buyer mid-payment must not lose their unit to an
  // adjustment. consumeStock deletes its own hold row in this same
  // transaction BEFORE calling here, so the sum already excludes it.
  if (args.delta < 0) {
    const [held] = await tx
      .select({
        reserved: sql<number>`coalesce(sum(${stockReservations.quantity}), 0)::int`.as("reserved"),
        soonest: sql<string | null>`min(${stockReservations.expiresAt})::text`.as("soonest"),
      })
      .from(stockReservations)
      .where(
        and(
          eq(stockReservations.variantId, args.variantId),
          sql`${stockReservations.expiresAt} > now()`,
        ),
      );
    const reserved = held?.reserved ?? 0;
    if (onHand < reserved) {
      throw new StockHeldError(onHand, reserved, held?.soonest ? new Date(held.soonest) : null);
    }
  }

  return { movementId: movement!.id, onHand };
}

/**
 * Record one stock movement and keep the projection true, atomically.
 *
 * Reason is chosen automatically: a variant's first movement is
 * `opening_balance`, everything after is `adjustment`. The response's
 * on-hand comes from the upsert's RETURNING, so before/after in the
 * audit row are exact even under concurrency.
 */
export async function recordMovement(
  ctx: WriteContext,
  input: MovementInput,
): Promise<MovementResult> {
  if (
    !Number.isInteger(input.delta) ||
    input.delta === 0 ||
    Math.abs(input.delta) > STOCK_ADJUSTMENT_MAX
  ) {
    throw new AppError({
      code: "invalid_payload",
      message: `delta must be a nonzero integer within ±${STOCK_ADJUSTMENT_MAX}, got ${input.delta}`,
      status: 422,
      publicMessage: "Some fields need attention.",
      details: { issues: [{ path: "delta", message: "Enter a nonzero whole number." }] },
    });
  }

  let result: MovementResult;
  try {
    result = await withTenant(ctx.tenantId, async (tx) => {
      const [variant] = await tx
        .select({
          id: productVariants.id,
          productId: productVariants.productId,
          tracksInventory: productVariants.tracksInventory,
        })
        .from(productVariants)
        .where(and(eq(productVariants.id, input.variantId), isNull(productVariants.deletedAt)))
        .limit(1);

      if (!variant) throw new VariantNotFoundError(input.variantId);
      if (!variant.tracksInventory) throw new UntrackedVariantError(input.variantId);

      // Fast path for a sequential retry; the 23505 catch below covers
      // the concurrent one.
      if (input.idempotencyKey) {
        const existing = await findByIdempotencyKey(tx, ctx.tenantId, input.idempotencyKey);
        if (existing) {
          // Idempotency fingerprint: the key must match the full request, not
          // just exist. Reusing a key with different parameters is a client bug.
          if (existing.variantId !== input.variantId || existing.delta !== input.delta) {
            throw new AppError({
              code: "idempotency_key_reuse",
              message: `Idempotency key "${input.idempotencyKey}" was already used for a different adjustment`,
              status: 422,
              publicMessage: "This idempotency key was already used for a different adjustment.",
            });
          }
          return { ...existing, replayed: true };
        }
      }

      const location = await ensureDefaultLocation(tx, ctx.tenantId);

      const [prior] = await tx
        .select({ id: stockMovements.id })
        .from(stockMovements)
        .where(eq(stockMovements.variantId, input.variantId))
        .limit(1);
      const reason: StockMovementReason = prior ? "adjustment" : "opening_balance";

      const { movementId, onHand } = await applyMovement(tx, {
        tenantId: ctx.tenantId,
        variantId: input.variantId,
        productId: variant.productId,
        locationId: location.id,
        delta: input.delta,
        reason,
        note: input.note ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        createdByUserId: ctx.actorUserId,
        referenceType: null,
        referenceId: null,
      });

      await recordAudit(tx, ctx.tenantId, {
        actorType: "staff",
        actorUserId: ctx.actorUserId,
        action: "inventory.adjusted",
        entityType: "product_variant",
        entityId: input.variantId,
        before: { onHand: onHand - input.delta },
        after: { onHand },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });

      return {
        movementId,
        variantId: input.variantId,
        productId: variant.productId,
        reason,
        delta: input.delta,
        onHand,
        replayed: false,
      };
    });
  } catch (err) {
    const pg = pgError(err);

    // The oversell guard fired. The transaction is already rolled back
    // (an aborted tx refuses further queries), so the on-hand for the
    // message comes from a fresh read.
    if (pg.code === "23514" && pg.text.includes("stock_levels_on_hand_check")) {
      const onHand = await withTenant(ctx.tenantId, async (tx) => {
        const levels = await getStockLevels(tx, [input.variantId]);
        return levels.get(input.variantId) ?? 0;
      });
      throw new InsufficientStockError(onHand, input.delta);
    }

    // Two concurrent submits with one key: the loser replays the winner.
    if (
      pg.code === "23505" &&
      pg.text.includes("stock_movements_tenant_idem_key") &&
      input.idempotencyKey
    ) {
      const replay = await withTenant(ctx.tenantId, (tx) =>
        findByIdempotencyKey(tx, ctx.tenantId, input.idempotencyKey!),
      );
      if (replay) {
        // Idempotency fingerprint: verify the replay matches the request.
        if (replay.variantId !== input.variantId || replay.delta !== input.delta) {
          throw new AppError({
            code: "idempotency_key_reuse",
            message: `Idempotency key "${input.idempotencyKey}" was already used for a different adjustment`,
            status: 422,
            publicMessage: "This idempotency key was already used for a different adjustment.",
          });
        }
        return { ...replay, replayed: true };
      }
    }

    // Two concurrent first movements: both INSERT the projection row,
    // loser hits the PRIMARY KEY constraint. Return a retryable 409.
    if (pg.code === "23505" && pg.text.includes("stock_levels")) {
      throw new AppError({
        code: "concurrent_modification",
        message: "Another movement created the projection row concurrently",
        status: 409,
        publicMessage: "Another stock movement was recorded at the same time. Please retry.",
      });
    }

    throw err;
  }

  // After the commit, never inside it. Fail-soft. A replay purges
  // nothing — it wrote nothing.
  if (!result.replayed) {
    await purgeStorefrontCache(ctx.tenantId, catalogPurgeTags(ctx.tenantId, [result.productId]));
  }

  return result;
}

/** Summed on-hand per variant, inside the caller's transaction. */
export async function getStockLevels(
  tx: Tx,
  variantIds: string[],
): Promise<Map<string, number>> {
  if (variantIds.length === 0) return new Map();
  const rows = await tx
    .select({
      variantId: stockLevels.variantId,
      onHand: sql<number>`coalesce(sum(${stockLevels.onHand}), 0)::int`.as("on_hand"),
    })
    .from(stockLevels)
    .where(inArray(stockLevels.variantId, variantIds))
    .groupBy(stockLevels.variantId);
  return new Map(rows.map((r) => [r.variantId, r.onHand]));
}

export type InventoryRow = {
  variantId: string;
  productId: string;
  productTitle: string;
  sku: string;
  options: Record<string, string>;
  onHand: number;
  lowStockAt: number | null;
  isActive: boolean;
};

/**
 * The /inventory page's query: tracked, live variants with their levels.
 *
 * A JOIN + GROUP BY rather than a correlated SELECT-list subquery — the
 * latter is the documented Drizzle trap (an interpolated outer column
 * renders unqualified and silently matches the inner table).
 */
export async function listInventory(
  tenantId: string,
  opts: { lowStockOnly?: boolean; limit?: number; offset?: number } = {},
): Promise<{ items: InventoryRow[]; total: number }> {
  const limit = Math.min(opts.limit ?? 50, 100);
  const offset = Math.max(opts.offset ?? 0, 0);

  return withTenant(tenantId, async (tx) => {
    const onHand = sql<number>`coalesce(sum(${stockLevels.onHand}), 0)::int`;
    // The condition only — .having() supplies the keyword. A null
    // threshold compares against -1, which a non-negative sum never
    // reaches: null lowStockAt = never low.
    const lowOnly = sql`coalesce(sum(${stockLevels.onHand}), 0) <= coalesce(${productVariants.lowStockAt}, -1)`;

    const rows = await tx
      .select({
        variantId: productVariants.id,
        productId: products.id,
        productTitle: products.title,
        sku: productVariants.sku,
        options: productVariants.options,
        lowStockAt: productVariants.lowStockAt,
        isActive: productVariants.isActive,
        onHand: onHand.as("on_hand"),
        total: sql<number>`count(*) over ()::int`.as("total"),
      })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .leftJoin(stockLevels, eq(stockLevels.variantId, productVariants.id))
      .where(
        and(
          eq(productVariants.tenantId, tenantId),
          eq(productVariants.tracksInventory, true),
          isNull(productVariants.deletedAt),
          isNull(products.deletedAt),
        ),
      )
      .groupBy(
        productVariants.id,
        products.id,
        products.title,
        productVariants.sku,
        productVariants.options,
        productVariants.lowStockAt,
        productVariants.isActive,
      )
      .having(opts.lowStockOnly ? lowOnly : undefined)
      .orderBy(asc(products.title), asc(productVariants.position))
      .limit(limit)
      .offset(offset);

    return {
      items: rows.map((r) => ({
        variantId: r.variantId,
        productId: r.productId,
        productTitle: r.productTitle,
        sku: r.sku,
        options: (r.options ?? {}) as Record<string, string>,
        onHand: r.onHand,
        lowStockAt: r.lowStockAt,
        isActive: r.isActive,
      })),
      total: rows[0]?.total ?? 0,
    };
  });
}

export type MovementRow = {
  id: string;
  delta: number;
  reason: StockMovementReason;
  note: string | null;
  createdAt: Date;
  createdByName: string | null;
};

/** A variant's movement history, newest first. `users` is control-plane (no RLS), so the join resolves. */
export async function getMovements(
  tenantId: string,
  variantId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<MovementRow[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  return withTenant(tenantId, (tx) =>
    tx
      .select({
        id: stockMovements.id,
        delta: stockMovements.delta,
        reason: stockMovements.reason,
        note: stockMovements.note,
        createdAt: stockMovements.createdAt,
        createdByName: users.name,
      })
      .from(stockMovements)
      .leftJoin(users, eq(users.id, stockMovements.createdByUserId))
      .where(eq(stockMovements.variantId, variantId))
      .orderBy(desc(stockMovements.createdAt), desc(stockMovements.id))
      .limit(limit)
      .offset(Math.max(opts.offset ?? 0, 0)),
  );
}

/**
 * SUM(ledger) vs projection, per (variant, location). Diagnostic — this
 * is the query that answers "why does this say 3 when I have 5?" and the
 * test that proves the projection cannot drift.
 */
export async function reconcileStockLevels(
  tenantId: string,
): Promise<{ variantId: string; locationId: string; ledger: number; projected: number }[]> {
  return withTenant(tenantId, async (tx) => {
    const ledger = await tx
      .select({
        variantId: stockMovements.variantId,
        locationId: stockMovements.locationId,
        ledger: sql<number>`sum(${stockMovements.delta})::int`.as("ledger"),
      })
      .from(stockMovements)
      .groupBy(stockMovements.variantId, stockMovements.locationId);

    const projected = await tx
      .select({
        variantId: stockLevels.variantId,
        locationId: stockLevels.locationId,
        projected: stockLevels.onHand,
      })
      .from(stockLevels);

    const key = (v: string, l: string) => `${v}:${l}`;
    const projectedBy = new Map(projected.map((p) => [key(p.variantId, p.locationId), p.projected]));
    const seen = new Set<string>();
    const mismatches: { variantId: string; locationId: string; ledger: number; projected: number }[] = [];

    for (const row of ledger) {
      const k = key(row.variantId, row.locationId);
      seen.add(k);
      const proj = projectedBy.get(k) ?? 0;
      if (proj !== row.ledger) {
        mismatches.push({ ...row, projected: proj });
      }
    }
    for (const p of projected) {
      if (!seen.has(key(p.variantId, p.locationId)) && p.projected !== 0) {
        mismatches.push({ variantId: p.variantId, locationId: p.locationId, ledger: 0, projected: p.projected });
      }
    }
    return mismatches;
  });
}

/** Checkout has no staff actor — reservation entry points take this, not WriteContext. */
export type ReservationContext = { tenantId: string; requestId?: string | null };

export class InsufficientAvailabilityError extends AppError {
  readonly failedLines: { variantId: string; requested: number; available: number }[];

  constructor(lines: { variantId: string; requested: number; available: number }[]) {
    super({
      code: "insufficient_stock",
      message: `Hold refused: ${lines
        .map((l) => `${l.variantId} requested ${l.requested}, available ${l.available}`)
        .join("; ")}`,
      status: 422,
      publicMessage: "Some items are no longer available in the quantity requested.",
      details: {
        issues: lines.map((l) => ({
          path: l.variantId,
          message: `Requested ${l.requested}, only ${l.available} available.`,
        })),
      },
    });
    this.failedLines = lines;
  }
}

function validateLines(lines: HoldLineInput[]): void {
  const refuse = (message: string): never => {
    throw new AppError({
      code: "invalid_payload",
      message: `Reservation lines invalid: ${message}`,
      status: 422,
      publicMessage: "Some fields need attention.",
      details: { issues: [{ path: "lines", message }] },
    });
  };
  if (lines.length === 0) refuse("at least one line is required");
  if (lines.length > 100) refuse("at most 100 lines per hold");
  const seen = new Set<string>();
  for (const line of lines) {
    if (
      !Number.isInteger(line.quantity) ||
      line.quantity <= 0 ||
      line.quantity > STOCK_ADJUSTMENT_MAX
    ) {
      refuse(`quantity for ${line.variantId} must be a positive whole number`);
    }
    if (seen.has(line.variantId)) refuse(`duplicate line for ${line.variantId}`);
    seen.add(line.variantId);
  }
}

/** Visibility + tracking lookup for every line; throws on any unknown id. */
async function loadLineVariants(
  tx: Tx,
  variantIds: string[],
): Promise<Map<string, { productId: string; tracksInventory: boolean }>> {
  const rows = await tx
    .select({
      id: productVariants.id,
      productId: productVariants.productId,
      tracksInventory: productVariants.tracksInventory,
    })
    .from(productVariants)
    .where(and(inArray(productVariants.id, variantIds), isNull(productVariants.deletedAt)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of variantIds) {
    if (!byId.has(id)) throw new VariantNotFoundError(id);
  }
  return byId;
}

/**
 * Lock the tracked lines' stock_levels rows FOR UPDATE in SORTED
 * variant-id order — the deadlock discipline for multi-line operations.
 * A variant with no levels row has on-hand 0 and nothing to lock; every
 * positive request against it simply fails the fit check.
 */
async function lockLevels(
  tx: Tx,
  locationId: string,
  lines: HoldLineInput[],
): Promise<Map<string, number>> {
  const onHandBy = new Map<string, number>();
  for (const line of [...lines].sort((a, b) => (a.variantId < b.variantId ? -1 : 1))) {
    const [level] = await tx
      .select({ onHand: stockLevels.onHand })
      .from(stockLevels)
      .where(
        and(eq(stockLevels.variantId, line.variantId), eq(stockLevels.locationId, locationId)),
      )
      .for("update");
    onHandBy.set(line.variantId, level?.onHand ?? 0);
  }
  return onHandBy;
}

/**
 * Place (or replace) a reference's hold. All-or-nothing across the
 * lines; re-holding the same reference replaces its set and refreshes
 * the 15-minute window. Untracked lines are skipped — they cannot run
 * out. See the spec's §2 for the full semantics.
 */
export async function holdStock(
  ctx: ReservationContext,
  input: { reference: ReservationReference; lines: HoldLineInput[] },
): Promise<{ lines: HoldLineResult[]; expiresAt: Date }> {
  validateLines(input.lines);
  try {
    return await withTenant(ctx.tenantId, async (tx) => {
      const variants = await loadLineVariants(
        tx,
        input.lines.map((l) => l.variantId),
      );
      const location = await ensureDefaultLocation(tx, ctx.tenantId);

      const tracked = input.lines.filter((l) => variants.get(l.variantId)!.tracksInventory);
      const onHandBy = await lockLevels(tx, location.id, tracked);

      // Replace semantics: this reference's previous set stops counting
      // BEFORE the fit sums — a re-hold must not compete with itself.
      // Deleting (not excluding in the sum) also covers lines the new
      // set no longer carries.
      await tx
        .delete(stockReservations)
        .where(
          and(
            eq(stockReservations.referenceType, input.reference.type),
            eq(stockReservations.referenceId, input.reference.id),
          ),
        );

      const failures: { variantId: string; requested: number; available: number }[] = [];
      for (const line of tracked) {
        // Free GC while we hold this variant's row lock.
        await tx
          .delete(stockReservations)
          .where(
            and(
              eq(stockReservations.variantId, line.variantId),
              sql`${stockReservations.expiresAt} <= now()`,
            ),
          );
        const [held] = await tx
          .select({
            reserved: sql<number>`coalesce(sum(${stockReservations.quantity}), 0)::int`.as(
              "reserved",
            ),
          })
          .from(stockReservations)
          .where(
            and(
              eq(stockReservations.variantId, line.variantId),
              sql`${stockReservations.expiresAt} > now()`,
            ),
          );
        const available = Math.max((onHandBy.get(line.variantId) ?? 0) - (held?.reserved ?? 0), 0);
        if (line.quantity > available) {
          failures.push({ variantId: line.variantId, requested: line.quantity, available });
        }
      }
      if (failures.length > 0) throw new InsufficientAvailabilityError(failures);

      // Informational fallback for an all-untracked hold; rows get the
      // authoritative Postgres now() + TTL.
      let expiresAt = new Date(Date.now() + RESERVATION_TTL_MINUTES * 60_000);
      if (tracked.length > 0) {
        const inserted = await tx
          .insert(stockReservations)
          .values(
            tracked.map((line) => ({
              tenantId: ctx.tenantId,
              variantId: line.variantId,
              locationId: location.id,
              quantity: line.quantity,
              referenceType: input.reference.type,
              referenceId: input.reference.id,
              expiresAt: sql`now() + make_interval(mins => ${RESERVATION_TTL_MINUTES})`,
            })),
          )
          .returning({ expiresAt: stockReservations.expiresAt });
        expiresAt = inserted[0]!.expiresAt;
      }

      return {
        lines: input.lines.map((line) => ({
          variantId: line.variantId,
          quantity: line.quantity,
          status: variants.get(line.variantId)!.tracksInventory
            ? ("held" as const)
            : ("untracked" as const),
        })),
        expiresAt,
      };
    });
  } catch (err) {
    const pg = pgError(err);
    // Two CONCURRENT holds for one reference: both replaced the old set,
    // both inserted, the loser hits the unique index. Retryable.
    if (pg.code === "23505" && pg.text.includes("stock_reservations_ref_variant_key")) {
      throw new AppError({
        code: "concurrent_modification",
        message: "Another hold for this reference landed concurrently",
        status: 409,
        publicMessage: "Your checkout was updated at the same time. Please retry.",
      });
    }
    throw err;
  }
}

/** Drop a reference's holds. Idempotent — releasing nothing is fine. */
export async function releaseStock(
  ctx: ReservationContext,
  reference: ReservationReference,
): Promise<{ released: number }> {
  return withTenant(ctx.tenantId, async (tx) => {
    const deleted = await tx
      .delete(stockReservations)
      .where(
        and(
          eq(stockReservations.referenceType, reference.type),
          eq(stockReservations.referenceId, reference.id),
        ),
      )
      .returning({ id: stockReservations.id });
    return { released: deleted.length };
  });
}

/**
 * Turn a reference's hold into sale movements, atomically. Lines come
 * from the CALLER (the order being created is the authority) — never
 * from the hold rows, which GC may erase mid-payment. Per line the hold
 * row is deleted FIRST, so applyMovement's stock_held guard no longer
 * counts it; if the stock is genuinely gone the on_hand CHECK refuses
 * and the WHOLE consume rolls back (zero sale movements survive).
 */
export async function consumeStock(
  ctx: ReservationContext,
  input: { reference: ReservationReference; lines: HoldLineInput[] },
): Promise<{ lines: ConsumeLineResult[] }> {
  validateLines(input.lines);
  let currentLine: HoldLineInput | null = null;
  let outcome: { lines: ConsumeLineResult[]; productIds: string[] };
  try {
    outcome = await withTenant(ctx.tenantId, async (tx) => {
      const variants = await loadLineVariants(
        tx,
        input.lines.map((l) => l.variantId),
      );
      const location = await ensureDefaultLocation(tx, ctx.tenantId);

      const tracked = input.lines
        .filter((l) => variants.get(l.variantId)!.tracksInventory)
        .sort((a, b) => (a.variantId < b.variantId ? -1 : 1));
      await lockLevels(tx, location.id, tracked);

      const results = new Map<string, ConsumeLineResult>();
      for (const line of input.lines) {
        if (!variants.get(line.variantId)!.tracksInventory) {
          results.set(line.variantId, {
            variantId: line.variantId,
            quantity: line.quantity,
            status: "untracked",
          });
        }
      }

      for (const line of tracked) {
        currentLine = line;
        const deleted = await tx
          .delete(stockReservations)
          .where(
            and(
              eq(stockReservations.referenceType, input.reference.type),
              eq(stockReservations.referenceId, input.reference.id),
              eq(stockReservations.variantId, line.variantId),
            ),
          )
          .returning({ expiresAt: stockReservations.expiresAt });
        // Informational only (app-clock comparison): "held" means the
        // buyer's guarantee was still standing when payment confirmed.
        const wasHeld = deleted.length > 0 && deleted[0]!.expiresAt.getTime() > Date.now();

        const applied = await applyMovement(tx, {
          tenantId: ctx.tenantId,
          variantId: line.variantId,
          productId: variants.get(line.variantId)!.productId,
          locationId: location.id,
          delta: -line.quantity,
          reason: "sale",
          note: null,
          idempotencyKey: null,
          createdByUserId: null,
          referenceType: input.reference.type,
          referenceId: input.reference.id,
        });
        results.set(line.variantId, {
          variantId: line.variantId,
          quantity: line.quantity,
          status: wasHeld ? "held" : "unheld",
          movementId: applied.movementId,
        });
      }
      currentLine = null;

      // Lines the order no longer carries: released — the order is the
      // authority on what was bought.
      await tx
        .delete(stockReservations)
        .where(
          and(
            eq(stockReservations.referenceType, input.reference.type),
            eq(stockReservations.referenceId, input.reference.id),
          ),
        );

      return {
        lines: input.lines.map((l) => results.get(l.variantId)!),
        productIds: [...new Set(tracked.map((l) => variants.get(l.variantId)!.productId))],
      };
    });
  } catch (err) {
    const pg = pgError(err);
    // The stolen path: an expired hold lost its unit to someone else.
    if (pg.code === "23514" && pg.text.includes("stock_levels_on_hand_check") && currentLine) {
      const line: HoldLineInput = currentLine;
      const available = await withTenant(ctx.tenantId, async (tx) => {
        const map = await getAvailability(tx, [line.variantId]);
        return map.get(line.variantId)?.available ?? 0;
      });
      throw new InsufficientAvailabilityError([
        { variantId: line.variantId, requested: line.quantity, available },
      ]);
    }
    throw err; // StockHeldError and everything else pass through intact
  }

  // After the commit, never inside it. Fail-soft. One purge for all
  // affected products.
  if (outcome.productIds.length > 0) {
    await purgeStorefrontCache(ctx.tenantId, catalogPurgeTags(ctx.tenantId, outcome.productIds));
  }
  return { lines: outcome.lines };
}

export type Availability = { onHand: number; reserved: number; available: number };

/**
 * on-hand, active-hold sum, and their clamped difference, per variant.
 * EVERY requested id gets an entry (unlike getStockLevels) — callers
 * need no ?? fallback. The PDP reads `available`; movement results and
 * the console product panel keep reading raw on-hand.
 */
export async function getAvailability(
  tx: Tx,
  variantIds: string[],
): Promise<Map<string, Availability>> {
  if (variantIds.length === 0) return new Map();
  const onHand = await getStockLevels(tx, variantIds);
  const reservedRows = await tx
    .select({
      variantId: stockReservations.variantId,
      reserved: sql<number>`coalesce(sum(${stockReservations.quantity}), 0)::int`.as("reserved"),
    })
    .from(stockReservations)
    .where(
      and(
        inArray(stockReservations.variantId, variantIds),
        sql`${stockReservations.expiresAt} > now()`,
      ),
    )
    .groupBy(stockReservations.variantId);
  const reservedBy = new Map(reservedRows.map((r) => [r.variantId, r.reserved]));

  const map = new Map<string, Availability>();
  for (const id of variantIds) {
    const on = onHand.get(id) ?? 0;
    const reserved = reservedBy.get(id) ?? 0;
    map.set(id, { onHand: on, reserved, available: Math.max(on - reserved, 0) });
  }
  return map;
}
