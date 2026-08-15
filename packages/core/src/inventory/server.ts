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
  users,
  withTenant,
} from "@platform/db";
import type { StockMovementReason, Tx } from "@platform/db";

import { recordAudit } from "../audit/index";
import { catalogPurgeTags } from "../catalog/cache-tags";
import { purgeStorefrontCache } from "../catalog/purge";
import type { WriteContext } from "../catalog/writes";
import { AppError } from "../errors";
import { STOCK_ADJUSTMENT_MAX } from "./index";

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
        if (existing) return { ...existing, replayed: true };
      }

      const location = await ensureDefaultLocation(tx, ctx.tenantId);

      const [prior] = await tx
        .select({ id: stockMovements.id })
        .from(stockMovements)
        .where(eq(stockMovements.variantId, input.variantId))
        .limit(1);
      const reason: StockMovementReason = prior ? "adjustment" : "opening_balance";

      const [movement] = await tx
        .insert(stockMovements)
        .values({
          tenantId: ctx.tenantId,
          variantId: input.variantId,
          locationId: location.id,
          delta: input.delta,
          reason,
          note: input.note ?? null,
          idempotencyKey: input.idempotencyKey ?? null,
          createdByUserId: ctx.actorUserId,
        })
        .returning({ id: stockMovements.id });

      // The projection upsert. For the first movement, INSERT. For subsequent,
      // UPDATE to avoid CHECK evaluation on negative INSERT values.
      let onHand: number;
      if (reason === "opening_balance") {
        const [level] = await tx
          .insert(stockLevels)
          .values({
            tenantId: ctx.tenantId,
            variantId: input.variantId,
            locationId: location.id,
            onHand: input.delta,
          })
          .returning({ onHand: stockLevels.onHand });
        onHand = level!.onHand;
      } else {
        const [level] = await tx
          .update(stockLevels)
          .set({
            onHand: sql.raw(`on_hand + ${input.delta}`),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(stockLevels.tenantId, ctx.tenantId),
              eq(stockLevels.variantId, input.variantId),
              eq(stockLevels.locationId, location.id),
            ),
          )
          .returning({ onHand: stockLevels.onHand });
        onHand = level!.onHand;
      }

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
        movementId: movement!.id,
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
      if (replay) return { ...replay, replayed: true };
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
