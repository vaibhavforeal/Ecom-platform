/**
 * Money.
 *
 * Everything is an integer count of paise, per PLATFORM_BLUEPRINT.md
 * §3.1. The two functions here are the boundary where that integer meets
 * a human — parsing what a merchant typed, and rendering what a customer
 * reads — and both are places where the usual shortcut is wrong.
 *
 * `Math.round(parseFloat("1299.10") * 100)` looks correct and mostly is.
 * It is also how you eventually book a ₹0.01 discrepancy that nobody can
 * reproduce, because some decimal strings have no exact binary
 * representation and the error only shows at particular magnitudes. The
 * parser below never converts through a float at all: it splits the
 * string and does integer arithmetic on the pieces.
 */

export const DEFAULT_CURRENCY = "INR";

/** Rendering locale. Indian grouping is lakh/crore, not thousands. */
const DEFAULT_LOCALE = "en-IN";

export class InvalidAmountError extends Error {
  constructor(input: string, reason: string) {
    super(`Cannot read "${input}" as an amount: ${reason}`);
    this.name = "InvalidAmountError";
  }
}

/**
 * Parses a merchant-typed amount in rupees into integer paise.
 *
 * Accepts "1299", "1,299", "₹1,299.00", "1299.5", " 1299 ". Rejects
 * anything with more than two decimal places rather than rounding it:
 * a merchant who typed 1299.999 meant something, and silently storing
 * ₹1300.00 is a price change they did not make and will not notice
 * until a customer is charged it.
 */
export function parseAmountToPaise(input: string): number {
  const cleaned = input
    .trim()
    .replace(/^[₹$€£]\s*/, "")
    .replace(/,/g, "")
    .replace(/\s/g, "");

  if (cleaned === "") throw new InvalidAmountError(input, "it is empty");

  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (!match) throw new InvalidAmountError(input, "it is not a plain number");

  const [, sign, whole = "0", fraction] = match;

  if (fraction !== undefined && fraction.length > 2) {
    throw new InvalidAmountError(
      input,
      `${fraction.length} decimal places, but a rupee amount has at most 2`,
    );
  }

  // Integer arithmetic throughout — the string is never turned into a
  // float, so there is nothing to round and nothing to drift.
  const paise = Number(whole) * 100 + Number((fraction ?? "").padEnd(2, "0"));

  if (!Number.isSafeInteger(paise)) {
    throw new InvalidAmountError(input, "it is too large to represent exactly");
  }

  return sign === "-" ? -paise : paise;
}

/**
 * Renders paise for display: 129900 → "₹1,29,900.00" in en-IN.
 *
 * Always two decimal places, including on round amounts. A price list
 * mixing "₹1,299" and "₹1,299.50" reads as inconsistent, and the
 * trailing ".00" is what signals the number is exact rather than
 * rounded for display.
 */
export function formatPaise(
  paise: number,
  opts: { currency?: string; locale?: string } = {},
): string {
  return new Intl.NumberFormat(opts.locale ?? DEFAULT_LOCALE, {
    style: "currency",
    currency: opts.currency ?? DEFAULT_CURRENCY,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(paise / 100);
}

/**
 * The bare decimal string, no symbol and no grouping: 129900 → "1299.00".
 *
 * This is the form for schema.org `Offer.price`, CSV export and form
 * inputs — all three of which are parsed by a machine that will choke on
 * a ₹ sign or a comma. Structured data in particular fails silently:
 * Google drops the offer and the rich result quietly stops appearing.
 */
export function paiseToDecimalString(paise: number): string {
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const whole = Math.floor(abs / 100);
  const fraction = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * Is `compareAt` a genuine strike-through price?
 *
 * A "was" price that is not above the current price is either a mistake
 * or a dark pattern. Both are worth refusing to render: the second is
 * illegal to advertise in several jurisdictions, and neither helps.
 */
export function hasValidDiscount(pricePaise: number, compareAtPaise: number | null): boolean {
  return compareAtPaise !== null && compareAtPaise > pricePaise;
}

/** Whole-percent discount, rounded down so it is never overstated. */
export function discountPercent(pricePaise: number, compareAtPaise: number | null): number | null {
  if (!hasValidDiscount(pricePaise, compareAtPaise) || compareAtPaise === null) return null;
  return Math.floor(((compareAtPaise - pricePaise) / compareAtPaise) * 100);
}
