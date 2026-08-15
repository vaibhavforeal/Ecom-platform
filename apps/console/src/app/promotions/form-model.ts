import { parseAmountToPaise } from "@platform/core/catalog";
import type {
  Condition,
  Effect,
  OrderChannel,
  PromotionData,
  PromotionStatus,
} from "@platform/core/promotions";

/**
 * The promotion form's OWN row model — every free-form field is a
 * string, converted to the typed Condition[]/Effect[] payload only at
 * submit. Editing "productIds: string[]" through a comma-separated text
 * input needs raw text state, or typing the comma itself becomes
 * impossible (parse → join round-trips eat it).
 *
 * No "use client" here on purpose: the server pages import the
 * converters too (a client module's exports are reference-only to a
 * server component).
 */

export type ConditionRow =
  | { type: "cart_subtotal_min"; rupees: string }
  | { type: "contains_product"; ids: string }
  | { type: "contains_category"; ids: string }
  | { type: "customer_segment"; segmentId: string }
  | { type: "first_order" }
  | { type: "channel"; channels: OrderChannel[] };

export type EffectRow =
  | { type: "flat_off"; rupees: string }
  | { type: "percent_off"; percent: string; maxRupees: string }
  | { type: "free_shipping" }
  | { type: "buy_x_get_y"; buyQty: string; getQty: string; ids: string };

export type PromotionFormState = {
  code: string;
  name: string;
  status: PromotionStatus;
  /** datetime-local values, fixed IST (see istToIso) — "" = unbounded. */
  startsAt: string;
  endsAt: string;
  usageLimitTotal: string;
  usageLimitPerCustomer: string;
  conditions: ConditionRow[];
  effects: EffectRow[];
};

export type Issue = { path: string; message: string };

/**
 * The console renders window times in IST with a FIXED offset rather
 * than the runtime timezone: the conversion must be identical on the
 * server render and in the browser, or hydration diverges.
 */
const IST_OFFSET_MINUTES = 330;

/** ISO instant → "YYYY-MM-DDTHH:mm" in IST, for a datetime-local input. */
export function isoToIstLocal(iso: string | null): string {
  if (!iso) return "";
  const utc = new Date(iso);
  if (Number.isNaN(utc.getTime())) return "";
  const shifted = new Date(utc.getTime() + IST_OFFSET_MINUTES * 60_000);
  return shifted.toISOString().slice(0, 16);
}

/** "YYYY-MM-DDTHH:mm" typed as IST → ISO instant, or null for "". */
export function istLocalToIso(local: string): string | null {
  if (local.trim() === "") return null;
  const asUtc = new Date(`${local}:00.000Z`);
  if (Number.isNaN(asUtc.getTime())) return null;
  return new Date(asUtc.getTime() - IST_OFFSET_MINUTES * 60_000).toISOString();
}

export function blankPromotion(): PromotionFormState {
  return {
    code: "",
    name: "",
    status: "draft",
    startsAt: "",
    endsAt: "",
    usageLimitTotal: "",
    usageLimitPerCustomer: "",
    conditions: [],
    effects: [{ type: "flat_off", rupees: "" }],
  };
}

export function blankConditionRow(type: ConditionRow["type"]): ConditionRow {
  switch (type) {
    case "cart_subtotal_min":
      return { type, rupees: "" };
    case "contains_product":
    case "contains_category":
      return { type, ids: "" };
    case "customer_segment":
      return { type, segmentId: "" };
    case "first_order":
      return { type };
    case "channel":
      return { type, channels: [] };
  }
}

export function blankEffectRow(type: EffectRow["type"]): EffectRow {
  switch (type) {
    case "flat_off":
      return { type, rupees: "" };
    case "percent_off":
      return { type, percent: "", maxRupees: "" };
    case "free_shipping":
      return { type };
    case "buy_x_get_y":
      return { type, buyQty: "", getQty: "", ids: "" };
  }
}

const paiseToRupees = (paise: number): string => String(paise / 100);

function conditionToRow(condition: Condition): ConditionRow {
  switch (condition.type) {
    case "cart_subtotal_min":
      return { type: condition.type, rupees: paiseToRupees(condition.paise) };
    case "contains_product":
      return { type: condition.type, ids: condition.productIds.join(", ") };
    case "contains_category":
      return { type: condition.type, ids: condition.categoryIds.join(", ") };
    case "customer_segment":
      return { type: condition.type, segmentId: condition.segmentId };
    case "first_order":
      return { type: condition.type };
    case "channel":
      return { type: condition.type, channels: condition.channels };
  }
}

function effectToRow(effect: Effect): EffectRow {
  switch (effect.type) {
    case "flat_off":
      return { type: effect.type, rupees: paiseToRupees(effect.paise) };
    case "percent_off":
      return {
        type: effect.type,
        percent: String(effect.bps / 100),
        maxRupees:
          effect.maxDiscountPaise === undefined ? "" : paiseToRupees(effect.maxDiscountPaise),
      };
    case "free_shipping":
      return { type: effect.type };
    case "buy_x_get_y":
      return {
        type: effect.type,
        buyQty: String(effect.buyQty),
        getQty: String(effect.getQty),
        ids: effect.getVariantIds.join(", "),
      };
  }
}

/** A stored promotion (dates already ISO strings) → editable form state. */
export function toFormState(promotion: {
  code: string;
  name: string;
  status: PromotionStatus;
  startsAt: string | null;
  endsAt: string | null;
  conditions: Condition[];
  effects: Effect[];
  usageLimitTotal: number | null;
  usageLimitPerCustomer: number | null;
}): PromotionFormState {
  return {
    code: promotion.code,
    name: promotion.name,
    status: promotion.status,
    startsAt: isoToIstLocal(promotion.startsAt),
    endsAt: isoToIstLocal(promotion.endsAt),
    usageLimitTotal: promotion.usageLimitTotal === null ? "" : String(promotion.usageLimitTotal),
    usageLimitPerCustomer:
      promotion.usageLimitPerCustomer === null ? "" : String(promotion.usageLimitPerCustomer),
    conditions: promotion.conditions.map(conditionToRow),
    effects: promotion.effects.map(effectToRow),
  };
}

/** Serializable shape the pages hand the client form. */
export function toSerializable(promotion: PromotionData) {
  return {
    ...promotion,
    startsAt: promotion.startsAt ? promotion.startsAt.toISOString() : null,
    endsAt: promotion.endsAt ? promotion.endsAt.toISOString() : null,
  };
}

/**
 * Rupees → paise through the repo's canonical string-decimal parser
 * (@platform/core/catalog money.ts), never `Number(value) * 100`: a
 * float shortcut silently rounds "99.999" to ₹100.00 — a discount the
 * merchant did not type — and accepts "1e5" as ₹1,00,000. More than two
 * decimal places is a refusal, not a rounding.
 */
function parseRupees(value: string, path: string, issues: Issue[], min: number): number {
  if (value.trim() === "") {
    issues.push({ path, message: "Enter an amount in rupees." });
    return min;
  }
  let paise: number;
  try {
    paise = parseAmountToPaise(value);
  } catch {
    issues.push({
      path,
      message: "Enter a plain rupee amount with at most 2 decimal places.",
    });
    return min;
  }
  if (paise < min) issues.push({ path, message: "The amount is too small." });
  return paise;
}

function parseIntField(value: string, path: string, issues: Issue[]): number {
  const n = Number(value.trim());
  if (value.trim() === "" || !Number.isInteger(n) || n < 1) {
    issues.push({ path, message: "Enter a whole number of at least 1." });
    return 1;
  }
  return n;
}

function parseIds(value: string, path: string, issues: Issue[]): string[] {
  const ids = value
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.length === 0) issues.push({ path, message: "Enter at least one id." });
  return ids;
}

function rowToCondition(row: ConditionRow, index: number, issues: Issue[]): Condition {
  const path = `conditions.${index}`;
  switch (row.type) {
    case "cart_subtotal_min":
      return { type: row.type, paise: parseRupees(row.rupees, path, issues, 0) };
    case "contains_product":
      return { type: row.type, productIds: parseIds(row.ids, path, issues) };
    case "contains_category":
      return { type: row.type, categoryIds: parseIds(row.ids, path, issues) };
    case "customer_segment":
      if (row.segmentId.trim() === "") issues.push({ path, message: "Enter a segment id." });
      return { type: row.type, segmentId: row.segmentId.trim() };
    case "first_order":
      return { type: row.type };
    case "channel":
      if (row.channels.length === 0) issues.push({ path, message: "Pick at least one channel." });
      return { type: row.type, channels: row.channels };
  }
}

function rowToEffect(row: EffectRow, index: number, issues: Issue[]): Effect {
  const path = `effects.${index}`;
  switch (row.type) {
    case "flat_off":
      return { type: row.type, paise: parseRupees(row.rupees, path, issues, 1) };
    case "percent_off": {
      const percent = Number(row.percent.trim());
      const bps = Math.round(percent * 100);
      if (row.percent.trim() === "" || !Number.isFinite(percent) || bps < 1 || bps > 10_000) {
        issues.push({ path, message: "Enter a percentage between 0.01 and 100." });
      }
      if (row.maxRupees.trim() === "") return { type: row.type, bps };
      return { type: row.type, bps, maxDiscountPaise: parseRupees(row.maxRupees, path, issues, 0) };
    }
    case "free_shipping":
      return { type: row.type };
    case "buy_x_get_y":
      return {
        type: row.type,
        buyQty: parseIntField(row.buyQty, path, issues),
        getQty: parseIntField(row.getQty, path, issues),
        getVariantIds: parseIds(row.ids, path, issues),
      };
  }
}

/**
 * Form state → the API payload, or field-level issues rendered exactly
 * like the server's own 422s (same {path, message} shape, one renderer).
 */
export function toPromotionPayload(
  state: PromotionFormState,
): { payload: Record<string, unknown>; issues: [] } | { payload: null; issues: Issue[] } {
  const issues: Issue[] = [];

  if (!/^[A-Z0-9_-]{3,40}$/i.test(state.code.trim())) {
    issues.push({ path: "code", message: "Use 3–40 letters, digits, _ or -." });
  }
  if (state.name.trim().length === 0) {
    issues.push({ path: "name", message: "A name is required." });
  }
  if (state.effects.length === 0) {
    issues.push({ path: "effects", message: "Add at least one effect." });
  }

  const conditions = state.conditions.map((row, i) => rowToCondition(row, i, issues));
  const effects = state.effects.map((row, i) => rowToEffect(row, i, issues));

  const limit = (value: string, path: string): number | null => {
    if (value.trim() === "") return null;
    const n = Number(value.trim());
    if (!Number.isInteger(n) || n < 1) {
      issues.push({ path, message: "Enter a whole number of at least 1, or leave blank." });
      return null;
    }
    return n;
  };
  const usageLimitTotal = limit(state.usageLimitTotal, "usageLimitTotal");
  const usageLimitPerCustomer = limit(state.usageLimitPerCustomer, "usageLimitPerCustomer");

  const startsAt = istLocalToIso(state.startsAt);
  const endsAt = istLocalToIso(state.endsAt);
  if (startsAt && endsAt && startsAt >= endsAt) {
    issues.push({ path: "endsAt", message: "The end must come after the start." });
  }

  if (issues.length > 0) return { payload: null, issues };

  return {
    payload: {
      code: state.code.trim().toUpperCase(),
      name: state.name.trim(),
      status: state.status,
      startsAt,
      endsAt,
      conditions,
      effects,
      usageLimitTotal,
      usageLimitPerCustomer,
    },
    issues: [],
  };
}
