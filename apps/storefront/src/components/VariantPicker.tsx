"use client";

import { useMemo, useState } from "react";

import { formatPaise, matchVariant, reachableValues } from "@platform/core/catalog";
import type { OptionAxis, OptionSelection } from "@platform/core/catalog";

/**
 * The PDP option selector.
 *
 * A client component, and the ONLY one on the product page. Everything
 * else renders on the server so the page stays a cacheable document —
 * blueprint §6.1 is explicit that live-looking details must not drag the
 * whole page into dynamic rendering, because that sacrifices the CDN
 * cache the page's ranking depends on.
 *
 * Unreachable combinations are shown DISABLED rather than hidden. A
 * shopper who cannot see "XL" concludes the store does not stock it; one
 * who sees it greyed out understands it is this colour that does not
 * come in XL, and switches colour.
 */

type Variant = {
  id: string;
  sku: string;
  options: OptionSelection;
  pricePaise: number;
  compareAtPaise: number | null;
  currency: string;
  isActive: boolean;
  tracksInventory: boolean;
  available: number | null;
};

export function VariantPicker({
  axes,
  variants,
}: {
  axes: OptionAxis[];
  variants: Variant[];
}) {
  const sellable = useMemo(
    () => variants.filter((v) => v.isActive && (v.available === null || v.available > 0)),
    [variants],
  );

  // Open on the cheapest variant, matching what the listing card
  // advertised. Anything else reads as a price that went up on click.
  const [selection, setSelection] = useState<OptionSelection>(() => {
    const cheapest = [...sellable].sort((a, b) => a.pricePaise - b.pricePaise)[0];
    return cheapest?.options ?? {};
  });

  const reachable = useMemo(
    () => reachableValues(axes, sellable, selection),
    [axes, sellable, selection],
  );

  const selected = matchVariant(sellable, selection);

  // Active but out of stock ≠ nonexistent: the shopper who sees
  // "out of stock" waits or switches; one who sees "not available"
  // concludes the combination was never made.
  const activeMatch = matchVariant(
    variants.filter((v) => v.isActive),
    selection,
  );

  if (axes.length === 0) return null;

  return (
    <div className="variant-picker">
      {axes.map((axis) => (
        <fieldset key={axis.name} className="axis">
          <legend>{axis.name}</legend>
          <div className="axis-values">
            {axis.values.map((value) => {
              const isSelected = selection[axis.name] === value;
              const isReachable = reachable[axis.name]?.includes(value) ?? false;

              return (
                <button
                  key={value}
                  type="button"
                  className="chip"
                  aria-pressed={isSelected}
                  disabled={!isReachable && !isSelected}
                  onClick={() => {
                    setSelection((current) => {
                      const next = { ...current, [axis.name]: value };
                      // Changing one axis can strand the others on a
                      // combination that no longer exists. Drop any that
                      // no longer resolve, so the picker cannot get
                      // stuck showing "unavailable" with no way out.
                      if (matchVariant(sellable, next)) return next;

                      const fallback = sellable.find((v) => v.options[axis.name] === value);
                      return fallback ? fallback.options : next;
                    });
                  }}
                >
                  {value}
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}

      <p className="selected-variant" aria-live="polite">
        {selected ? (
          <>
            <span className="price">
              {formatPaise(selected.pricePaise, { currency: selected.currency })}
            </span>
            <span className="muted"> · SKU {selected.sku}</span>
          </>
        ) : (
          <span className="muted">
            {activeMatch ? "Out of stock." : "That combination is not available."}
          </span>
        )}
      </p>
    </div>
  );
}
