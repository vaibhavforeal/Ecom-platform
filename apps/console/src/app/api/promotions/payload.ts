import { PROMOTION_STATUSES, conditionSchema, effectSchema } from "@platform/core/promotions";
import type { PromotionInput } from "@platform/core/promotions/server";
import { z } from "zod";

/**
 * The one payload shape POST and PUT share (design §7): rules ride the
 * SAME conditionSchema/effectSchema unions the domain layer validates
 * with, so a refusal reads identically whichever door it came from.
 * Dates cross the wire as ISO strings; the domain takes Dates.
 */
export const promotionPayloadSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[A-Z0-9_-]{3,40}$/i, { message: "Use 3–40 letters, digits, _ or -." }),
  name: z.string().trim().min(1).max(120),
  status: z.enum(PROMOTION_STATUSES),
  startsAt: z.string().datetime({ offset: true }).nullish(),
  endsAt: z.string().datetime({ offset: true }).nullish(),
  conditions: z.array(conditionSchema).max(20),
  effects: z.array(effectSchema).min(1).max(10),
  usageLimitTotal: z.number().int().min(1).max(1_000_000).nullish(),
  usageLimitPerCustomer: z.number().int().min(1).max(1_000_000).nullish(),
});

export type PromotionPayload = z.infer<typeof promotionPayloadSchema>;

export function toPromotionInput(payload: PromotionPayload): PromotionInput {
  return {
    code: payload.code,
    name: payload.name,
    status: payload.status,
    startsAt: payload.startsAt ? new Date(payload.startsAt) : null,
    endsAt: payload.endsAt ? new Date(payload.endsAt) : null,
    conditions: payload.conditions,
    effects: payload.effects,
    usageLimitTotal: payload.usageLimitTotal ?? null,
    usageLimitPerCustomer: payload.usageLimitPerCustomer ?? null,
  };
}
