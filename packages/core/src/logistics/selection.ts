import type { CarrierCode, ServiceabilityQuote } from "./types";

/**
 * Carrier selection — "rate shopping".
 *
 * A pure function, deliberately. Which carrier gets a parcel decides
 * freight cost, delivery speed and RTO probability, so this is the
 * highest-leverage decision the fulfilment layer makes, and it must be
 * exhaustively testable without touching a network.
 *
 * The naive version picks the cheapest quote. That is usually wrong in
 * India: the cheapest carrier on a given lane often has the worst
 * delivery success rate, and one RTO wipes out the saving on twenty
 * shipments. Hence `performanceScore` and the `balanced` strategy.
 */

export type SelectionStrategy =
  | "cheapest"
  | "fastest"
  | "balanced"
  | "preferred"; // strict merchant-defined carrier order

export type SelectionRules = {
  strategy: SelectionStrategy;
  /** Consulted in order for `preferred`; a tiebreak for other strategies. */
  preferredOrder?: CarrierCode[];
  /** Never use these, whatever they quote. */
  excludeCarriers?: CarrierCode[];
  /** Reject quotes slower than this. */
  maxEstimatedDays?: number;
  /** Reject quotes above this freight cost. */
  maxFreightPaise?: number;
  /** Reject carriers below this historical success rate on the lane. */
  minPerformanceScore?: number;
  /**
   * For `balanced`: how much a day of transit is worth, in paise.
   * Lets a merchant say "I will pay ₹15 to arrive a day sooner."
   */
  dayValuePaise?: number;
  /**
   * For `balanced`: cost of an RTO, in paise. Weighted by predicted
   * failure rate so unreliable carriers price themselves out.
   * Defaults to twice the freight, a reasonable proxy for
   * forward + return leg with the goods back in stock.
   */
  rtoCostPaise?: number;
};

export const DEFAULT_RULES: SelectionRules = {
  strategy: "balanced",
  dayValuePaise: 1500, // ₹15/day
};

export type ScoredQuote = {
  quote: ServiceabilityQuote;
  /** Lower is better. Expected total cost in paise for `balanced`. */
  score: number;
  breakdown: Record<string, number>;
};

export type SelectionResult = {
  chosen: ServiceabilityQuote | null;
  ranked: ScoredQuote[];
  /** Quotes removed by constraints, with the reason. Shown in the console. */
  rejected: { quote: ServiceabilityQuote; reason: string }[];
};

function applyConstraints(
  quotes: ServiceabilityQuote[],
  rules: SelectionRules,
  paymentModeCod: boolean,
): SelectionResult["rejected"] {
  const rejected: SelectionResult["rejected"] = [];

  for (const q of quotes) {
    if (paymentModeCod && !q.codSupported) {
      rejected.push({ quote: q, reason: "Does not support COD" });
      continue;
    }
    if (rules.excludeCarriers?.includes(q.carrier)) {
      rejected.push({ quote: q, reason: "Excluded by merchant rules" });
      continue;
    }
    if (rules.maxEstimatedDays != null && q.estimatedDays > rules.maxEstimatedDays) {
      rejected.push({
        quote: q,
        reason: `Too slow (${q.estimatedDays}d > ${rules.maxEstimatedDays}d)`,
      });
      continue;
    }
    if (rules.maxFreightPaise != null && q.totalPaise > rules.maxFreightPaise) {
      rejected.push({ quote: q, reason: "Above freight cap" });
      continue;
    }
    if (
      rules.minPerformanceScore != null &&
      q.performanceScore != null &&
      q.performanceScore < rules.minPerformanceScore
    ) {
      rejected.push({
        quote: q,
        reason: `Lane performance ${(q.performanceScore * 100).toFixed(0)}% below minimum`,
      });
      continue;
    }
  }

  return rejected;
}

function scoreQuote(q: ServiceabilityQuote, rules: SelectionRules): ScoredQuote {
  switch (rules.strategy) {
    case "cheapest":
      return { quote: q, score: q.totalPaise, breakdown: { freight: q.totalPaise } };

    case "fastest":
      // Cost breaks ties between carriers promising the same day count.
      return {
        quote: q,
        score: q.estimatedDays * 1_000_000 + q.totalPaise,
        breakdown: { days: q.estimatedDays, freight: q.totalPaise },
      };

    case "preferred": {
      const idx = rules.preferredOrder?.indexOf(q.carrier) ?? -1;
      // Unlisted carriers sort last but remain usable as a fallback,
      // so a preferred carrier being down does not block the order.
      const rank = idx === -1 ? 9_999 : idx;
      return {
        quote: q,
        score: rank * 1_000_000 + q.totalPaise,
        breakdown: { preferenceRank: rank, freight: q.totalPaise },
      };
    }

    case "balanced": {
      // Expected total cost, not sticker price:
      //   freight + (time penalty) + (failure probability × RTO cost)
      const freight = q.totalPaise;
      const dayValue = rules.dayValuePaise ?? DEFAULT_RULES.dayValuePaise ?? 0;
      const timePenalty = q.estimatedDays * dayValue;

      // No history yet ⇒ assume a neutral 90%. Optimistic enough not to
      // freeze out a new carrier, pessimistic enough to prefer a proven one.
      const success = q.performanceScore ?? 0.9;
      const failureRate = Math.max(0, Math.min(1, 1 - success));
      const rtoCost = rules.rtoCostPaise ?? freight * 2;
      const riskCost = Math.round(failureRate * rtoCost);

      return {
        quote: q,
        score: freight + timePenalty + riskCost,
        breakdown: { freight, timePenalty, riskCost, successRate: success },
      };
    }
  }
}

/**
 * Rank the quotes and pick one.
 *
 * Returns the full ranking and every rejection with its reason, because
 * "why did this parcel go by the expensive carrier?" is a question
 * merchants ask constantly and most platforms cannot answer.
 */
export function selectCarrier(
  quotes: ServiceabilityQuote[],
  rules: SelectionRules = DEFAULT_RULES,
  opts: { paymentModeCod: boolean } = { paymentModeCod: false },
): SelectionResult {
  if (quotes.length === 0) {
    return { chosen: null, ranked: [], rejected: [] };
  }

  const rejected = applyConstraints(quotes, rules, opts.paymentModeCod);
  const rejectedSet = new Set(rejected.map((r) => r.quote));
  const eligible = quotes.filter((q) => !rejectedSet.has(q));

  if (eligible.length === 0) {
    return { chosen: null, ranked: [], rejected };
  }

  const ranked = eligible
    .map((q) => scoreQuote(q, rules))
    .sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      // Deterministic tiebreak. Without it, equal-scoring carriers
      // alternate between runs and lane performance data never converges.
      const pa = rules.preferredOrder?.indexOf(a.quote.carrier) ?? -1;
      const pb = rules.preferredOrder?.indexOf(b.quote.carrier) ?? -1;
      if (pa !== pb) return (pa === -1 ? 9_999 : pa) - (pb === -1 ? 9_999 : pb);
      return a.quote.carrier.localeCompare(b.quote.carrier);
    });

  return { chosen: ranked[0]?.quote ?? null, ranked, rejected };
}

/**
 * Lane performance score from our own history.
 *
 * Deliberately computed from observed outcomes rather than taken from
 * carrier marketing. Laplace smoothing keeps a carrier with three
 * successful deliveries from scoring a perfect 1.0 and monopolising a
 * lane on no real evidence.
 */
export function laneSuccessScore(input: {
  delivered: number;
  rto: number;
  lost: number;
}): number {
  const attempts = input.delivered + input.rto + input.lost;
  if (attempts === 0) return 0.9; // neutral prior
  return (input.delivered + 9) / (attempts + 10);
}
