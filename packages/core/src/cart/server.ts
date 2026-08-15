import {
  and,
  asc,
  carts,
  cartLines,
  eq,
  inArray,
  isNull,
  productCategories,
  productVariants,
  products,
  promotions,
  sql,
  withTenant,
} from "@platform/db";
import type { Tx } from "@platform/db";

import { AppError } from "../errors";
import { getAvailability } from "../inventory/server";
import { evaluatePromotion } from "../promotions/index";
import type { CartForEvaluation, Condition, Effect, PromotionData } from "../promotions/index";
import { CART_LINE_MAX_QUANTITY, CART_MAX_LINES } from "./index";
import type { BuyerContext, CartCouponPreview, CartView, CartViewLine } from "./index";

/**
 * Cart — SERVER barrel. S0 SCHEMA SPINE: signatures FROZEN; bodies
 * implemented by lot B4.
 *
 * Rules the implementation must keep: every variant id from a payload is
 * verified with a visibility SELECT inside the tx (FK ≠ tenancy); prices
 * are read live, never stored on cart_lines; availability reads keep the
 * `expires_at > now()` hold filter; cart reads are NEVER unstable_cache'd.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cartNotFound(): AppError {
  return new AppError({
    code: "not_found",
    message: "Cart not found in this tenant",
    status: 404,
    publicMessage: "That cart does not exist.",
  });
}

function invalidPayload(path: string, message: string): AppError {
  return new AppError({
    code: "invalid_payload",
    message: `Invalid cart input: ${path}: ${message}`,
    status: 422,
    publicMessage: message,
    details: { issues: [{ path, message }] },
  });
}

/** SELECT the active cart or throw 404. Inside the caller's tx. */
async function loadActiveCart(tx: Tx, tenantId: string, cartId: string): Promise<{ id: string }> {
  if (!UUID_RE.test(cartId)) throw cartNotFound();
  const [cart] = await tx
    .select({ id: carts.id })
    .from(carts)
    .where(and(eq(carts.tenantId, tenantId), eq(carts.id, cartId), eq(carts.status, "active")))
    .limit(1);
  if (!cart) throw cartNotFound();
  return cart;
}

async function touchCart(tx: Tx, tenantId: string, cartId: string): Promise<void> {
  await tx
    .update(carts)
    .set({ updatedAt: sql`now()` })
    .where(and(eq(carts.tenantId, tenantId), eq(carts.id, cartId)));
}

/**
 * Returns the existing active cart or creates one. The id goes into an
 * httpOnly cookie scoped to the storefront host — a cookie replayed
 * against another tenant's host matches zero rows via RLS.
 */
export async function getOrCreateCart(
  ctx: BuyerContext,
  cartId: string | null,
): Promise<{ cartId: string; created: boolean }> {
  return withTenant(ctx.tenantId, async (tx) => {
    // A garbage cookie value is "no cart", never a 500: the cookie is
    // browser-controlled input.
    if (cartId && UUID_RE.test(cartId)) {
      const [existing] = await tx
        .select({ id: carts.id })
        .from(carts)
        .where(and(eq(carts.tenantId, ctx.tenantId), eq(carts.id, cartId), eq(carts.status, "active")))
        .limit(1);
      if (existing) return { cartId: existing.id, created: false };
    }

    // UUIDv7 primary key from the schema default — non-enumerable, and
    // nothing here increments anything.
    const [created] = await tx
      .insert(carts)
      .values({ tenantId: ctx.tenantId })
      .returning({ id: carts.id });
    if (!created) {
      throw new Error("carts INSERT returned no row — is the transaction missing tenant context?");
    }
    return { cartId: created.id, created: true };
  });
}

/**
 * Upsert one line (ON CONFLICT (tenant_id, cart_id, variant_id) DO
 * UPDATE); quantity 0 removes. Refuses `insufficient_stock` (422) when
 * requested > available for tracked variants. Touches carts.updated_at.
 */
export async function upsertLine(
  ctx: BuyerContext,
  cartId: string,
  input: { variantId: string; quantity: number },
): Promise<CartView> {
  // Cheap invariants before the transaction (write-door recipe step 2).
  if (typeof input.variantId !== "string" || !UUID_RE.test(input.variantId)) {
    throw invalidPayload("variantId", "That variant does not exist.");
  }
  if (
    !Number.isSafeInteger(input.quantity) ||
    input.quantity < 0 ||
    input.quantity > CART_LINE_MAX_QUANTITY
  ) {
    throw invalidPayload(
      "quantity",
      `Quantity must be a whole number between 0 and ${CART_LINE_MAX_QUANTITY}.`,
    );
  }

  return withTenant(ctx.tenantId, async (tx) => {
    const cart = await loadActiveCart(tx, ctx.tenantId, cartId);

    if (input.quantity === 0) {
      await tx
        .delete(cartLines)
        .where(
          and(
            eq(cartLines.tenantId, ctx.tenantId),
            eq(cartLines.cartId, cart.id),
            eq(cartLines.variantId, input.variantId),
          ),
        );
      await touchCart(tx, ctx.tenantId, cart.id);
      return (await readCartView(tx, ctx.tenantId, cart.id))!;
    }

    // Visibility SELECT before trusting the payload id — the FK does NOT
    // enforce tenancy, and an inactive/deleted variant must not be
    // addable however its id was obtained.
    const [variant] = await tx
      .select({
        id: productVariants.id,
        tracksInventory: productVariants.tracksInventory,
      })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(
        and(
          eq(productVariants.tenantId, ctx.tenantId),
          eq(productVariants.id, input.variantId),
          eq(productVariants.isActive, true),
          isNull(productVariants.deletedAt),
          eq(products.tenantId, ctx.tenantId),
          eq(products.status, "active"),
          isNull(products.deletedAt),
        ),
      )
      .limit(1);
    if (!variant) {
      throw new AppError({
        code: "not_found",
        message: `Variant ${input.variantId} not visible in this tenant`,
        status: 404,
        publicMessage: "That product is not available.",
      });
    }

    // Availability keeps the expires_at > now() hold filter — it lives
    // inside getAvailability and every reader keeps it.
    if (variant.tracksInventory) {
      const availability = (await getAvailability(tx, [variant.id])).get(variant.id)!;
      if (input.quantity > availability.available) {
        throw new AppError({
          code: "insufficient_stock",
          message: `Requested ${input.quantity} of variant ${variant.id}; available is ${availability.available}`,
          status: 422,
          publicMessage:
            availability.available === 0
              ? "That item is out of stock."
              : `Only ${availability.available} left in stock.`,
          details: {
            issues: [
              {
                path: "quantity",
                message:
                  availability.available === 0
                    ? "Out of stock."
                    : `Only ${availability.available} available.`,
              },
            ],
          },
        });
      }
    }

    // The line cap mirrors holdStock's per-hold cap so a cart that fits
    // here always fits a checkout hold. Only a NEW line can breach it.
    const [existingLine] = await tx
      .select({ id: cartLines.id })
      .from(cartLines)
      .where(
        and(
          eq(cartLines.tenantId, ctx.tenantId),
          eq(cartLines.cartId, cart.id),
          eq(cartLines.variantId, input.variantId),
        ),
      )
      .limit(1);
    if (!existingLine) {
      const [lineCount] = await tx
        .select({ n: sql<number>`count(*)::int`.as("n") })
        .from(cartLines)
        .where(and(eq(cartLines.tenantId, ctx.tenantId), eq(cartLines.cartId, cart.id)));
      if ((lineCount?.n ?? 0) >= CART_MAX_LINES) {
        throw invalidPayload("variantId", `A cart can hold at most ${CART_MAX_LINES} items.`);
      }
    }

    await tx
      .insert(cartLines)
      .values({
        tenantId: ctx.tenantId,
        cartId: cart.id,
        variantId: input.variantId,
        quantity: input.quantity,
      })
      .onConflictDoUpdate({
        target: [cartLines.tenantId, cartLines.cartId, cartLines.variantId],
        set: { quantity: input.quantity, updatedAt: sql`now()` },
      });

    await touchCart(tx, ctx.tenantId, cart.id);
    return (await readCartView(tx, ctx.tenantId, cart.id))!;
  });
}

export async function removeLine(
  ctx: BuyerContext,
  cartId: string,
  variantId: string,
): Promise<CartView> {
  if (typeof variantId !== "string" || !UUID_RE.test(variantId)) {
    throw invalidPayload("variantId", "That variant does not exist.");
  }
  return withTenant(ctx.tenantId, async (tx) => {
    const cart = await loadActiveCart(tx, ctx.tenantId, cartId);
    // Removing an absent line is idempotent — the state asked for exists.
    await tx
      .delete(cartLines)
      .where(
        and(
          eq(cartLines.tenantId, ctx.tenantId),
          eq(cartLines.cartId, cart.id),
          eq(cartLines.variantId, variantId),
        ),
      );
    await touchCart(tx, ctx.tenantId, cart.id);
    return (await readCartView(tx, ctx.tenantId, cart.id))!;
  });
}

/** Live prices + availability + read-only coupon preview. Null: no such cart. */
export async function getCartView(ctx: BuyerContext, cartId: string): Promise<CartView | null> {
  if (typeof cartId !== "string" || !UUID_RE.test(cartId)) return null;
  return withTenant(ctx.tenantId, (tx) => readCartView(tx, ctx.tenantId, cartId));
}

/** Stores the uppercased code; evaluation stays read-only until confirm. */
export async function setCartCoupon(
  ctx: BuyerContext,
  cartId: string,
  code: string,
): Promise<CartView> {
  const normalized = typeof code === "string" ? code.trim().toUpperCase() : "";
  if (normalized.length === 0 || normalized.length > 40) {
    throw invalidPayload("code", "Enter a coupon code (up to 40 characters).");
  }
  return withTenant(ctx.tenantId, async (tx) => {
    const cart = await loadActiveCart(tx, ctx.tenantId, cartId);
    await tx
      .update(carts)
      .set({ couponCode: normalized, updatedAt: sql`now()` })
      .where(and(eq(carts.tenantId, ctx.tenantId), eq(carts.id, cart.id)));
    return (await readCartView(tx, ctx.tenantId, cart.id))!;
  });
}

export async function clearCartCoupon(ctx: BuyerContext, cartId: string): Promise<CartView> {
  return withTenant(ctx.tenantId, async (tx) => {
    const cart = await loadActiveCart(tx, ctx.tenantId, cartId);
    await tx
      .update(carts)
      .set({ couponCode: null, updatedAt: sql`now()` })
      .where(and(eq(carts.tenantId, ctx.tenantId), eq(carts.id, cart.id)));
    return (await readCartView(tx, ctx.tenantId, cart.id))!;
  });
}

/**
 * The one view assembler, inside the caller's tx so a mutation's response
 * reflects exactly what it committed. Lines whose variant or product has
 * gone invisible since being added are omitted from the VIEW (never
 * deleted here — reads stay reads); checkout re-verifies visibility
 * anyway, so a delisted line can never reach an order.
 */
async function readCartView(tx: Tx, tenantId: string, cartId: string): Promise<CartView | null> {
  const [cart] = await tx
    .select({
      id: carts.id,
      status: carts.status,
      currency: carts.currency,
      couponCode: carts.couponCode,
    })
    .from(carts)
    .where(and(eq(carts.tenantId, tenantId), eq(carts.id, cartId)))
    .limit(1);
  if (!cart) return null;

  const rows = await tx
    .select({
      variantId: cartLines.variantId,
      quantity: cartLines.quantity,
      createdAt: cartLines.createdAt,
      productId: productVariants.productId,
      sku: productVariants.sku,
      options: productVariants.options,
      pricePaise: productVariants.pricePaise,
      tracksInventory: productVariants.tracksInventory,
      title: products.title,
    })
    .from(cartLines)
    .innerJoin(productVariants, eq(productVariants.id, cartLines.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      and(
        eq(cartLines.tenantId, tenantId),
        eq(cartLines.cartId, cartId),
        eq(productVariants.isActive, true),
        isNull(productVariants.deletedAt),
        eq(products.status, "active"),
        isNull(products.deletedAt),
      ),
    )
    .orderBy(asc(cartLines.createdAt));

  // Live availability — never cached, hold filter inside getAvailability.
  const trackedIds = rows.filter((r) => r.tracksInventory).map((r) => r.variantId);
  const availability = await getAvailability(tx, trackedIds);

  const lines: CartViewLine[] = rows.map((r) => ({
    variantId: r.variantId,
    productId: r.productId,
    title: r.title,
    sku: r.sku,
    options: (r.options ?? {}) as Record<string, string>,
    quantity: r.quantity,
    unitPricePaise: r.pricePaise,
    lineTotalPaise: r.pricePaise * r.quantity,
    available: r.tracksInventory ? (availability.get(r.variantId)?.available ?? 0) : null,
  }));

  const subtotalPaise = lines.reduce((sum, l) => sum + l.lineTotalPaise, 0);

  const couponPreview = cart.couponCode
    ? await previewCoupon(tx, tenantId, cart.couponCode, lines, subtotalPaise)
    : null;

  return {
    cartId: cart.id,
    status: cart.status,
    currency: cart.currency,
    lines,
    subtotalPaise,
    couponCode: cart.couponCode,
    couponPreview,
  };
}

/**
 * Read-only evaluation of the stored code — never a claim, never a lock
 * (the FOR UPDATE load belongs to checkout-start, D8). Usage limits are
 * deliberately not previewed: counting them here would serialize every
 * cart read on the promotion row for an answer that confirm re-checks
 * anyway.
 */
async function previewCoupon(
  tx: Tx,
  tenantId: string,
  code: string,
  lines: CartViewLine[],
  subtotalPaise: number,
): Promise<CartCouponPreview> {
  const [promo] = await tx
    .select()
    .from(promotions)
    .where(and(eq(promotions.tenantId, tenantId), eq(promotions.code, code)))
    .limit(1);

  if (!promo || promo.status !== "active") {
    return {
      code,
      applicable: false,
      discountPaise: 0,
      freeShipping: false,
      reason: "unknown_code",
    };
  }

  const promoData: PromotionData = {
    id: promo.id,
    code: promo.code,
    name: promo.name,
    status: promo.status,
    startsAt: promo.startsAt,
    endsAt: promo.endsAt,
    conditions: (promo.conditions ?? []) as Condition[],
    effects: (promo.effects ?? []) as Effect[],
    usageLimitTotal: promo.usageLimitTotal,
    usageLimitPerCustomer: promo.usageLimitPerCustomer,
  };

  // categoryIds per line for `contains_category` — one query for the set.
  const productIds = [...new Set(lines.map((l) => l.productId))];
  const categoriesByProduct = new Map<string, string[]>();
  if (productIds.length > 0) {
    const categoryRows = await tx
      .select({
        productId: productCategories.productId,
        categoryId: productCategories.categoryId,
      })
      .from(productCategories)
      .where(
        and(
          eq(productCategories.tenantId, tenantId),
          inArray(productCategories.productId, productIds),
        ),
      );
    for (const row of categoryRows) {
      const list = categoriesByProduct.get(row.productId) ?? [];
      list.push(row.categoryId);
      categoriesByProduct.set(row.productId, list);
    }
  }

  const cartForEvaluation: CartForEvaluation = {
    lines: lines.map((l) => ({
      variantId: l.variantId,
      productId: l.productId,
      categoryIds: categoriesByProduct.get(l.productId) ?? [],
      quantity: l.quantity,
      unitPricePaise: l.unitPricePaise,
    })),
    subtotalPaise,
    // The cart stage has no shipping fee yet; free_shipping previews as
    // applicable-with-zero-value, exactly as §6.3 specifies.
    shippingPaise: 0,
    channel: "web",
  };

  // Anonymous preview: null customer — `first_order` reports "may apply".
  const result = evaluatePromotion(promoData, cartForEvaluation, null, new Date());
  if (result.applicable) {
    return {
      code,
      applicable: true,
      discountPaise: result.discount.discountPaise,
      freeShipping: result.discount.freeShipping,
    };
  }
  return { code, applicable: false, discountPaise: 0, freeShipping: false, reason: result.reason };
}
