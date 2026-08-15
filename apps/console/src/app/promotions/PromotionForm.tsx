"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { ORDER_CHANNELS, PROMOTION_STATUSES } from "@platform/core/promotions";
import type { OrderChannel } from "@platform/core/promotions";

import {
  blankConditionRow,
  blankEffectRow,
  toPromotionPayload,
} from "./form-model";
import type { ConditionRow, EffectRow, Issue, PromotionFormState } from "./form-model";

/**
 * The promotion builder. PURE barrel imports only — this bundle must
 * never pull @platform/db. Rules are edited as structured rows and
 * become the typed Condition[]/Effect[] payload at submit; every
 * refusal (client conversion or server 422) renders through the one
 * {path, message} list.
 */

const CONDITION_LABELS: Record<ConditionRow["type"], string> = {
  cart_subtotal_min: "Cart subtotal at least",
  contains_product: "Cart contains a product",
  contains_category: "Cart contains a category",
  customer_segment: "Customer segment (Phase 4)",
  first_order: "First order only",
  channel: "Sales channel",
};

const EFFECT_LABELS: Record<EffectRow["type"], string> = {
  flat_off: "Flat amount off",
  percent_off: "Percentage off",
  free_shipping: "Free shipping",
  buy_x_get_y: "Buy X get Y",
};

type Props = {
  mode: "create" | "edit";
  promotionId?: string;
  initial: PromotionFormState;
  canWrite: boolean;
};

export function PromotionForm({ mode, promotionId, initial, canWrite }: Props) {
  const router = useRouter();
  const [state, setState] = useState<PromotionFormState>(initial);
  const [busy, setBusy] = useState(false);
  const [issues, setIssues] = useState<Issue[]>([]);

  const set = (patch: Partial<PromotionFormState>) => setState((s) => ({ ...s, ...patch }));

  const setCondition = (index: number, row: ConditionRow) =>
    setState((s) => ({
      ...s,
      conditions: s.conditions.map((c, i) => (i === index ? row : c)),
    }));

  const setEffect = (index: number, row: EffectRow) =>
    setState((s) => ({
      ...s,
      effects: s.effects.map((e, i) => (i === index ? row : e)),
    }));

  const removeAt = <T,>(list: T[], index: number): T[] => list.filter((_, i) => i !== index);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setIssues([]);

    const built = toPromotionPayload(state);
    if (built.payload === null) {
      setIssues(built.issues);
      return;
    }

    setBusy(true);
    try {
      const res = await fetch(
        mode === "create" ? "/api/promotions" : `/api/promotions/${promotionId}`,
        {
          method: mode === "create" ? "POST" : "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(built.payload),
        },
      );
      const data = (await res.json()) as {
        error?: { message?: string; details?: { issues?: Issue[] } };
      };
      if (!res.ok) {
        setIssues(
          data.error?.details?.issues ?? [
            { path: "form", message: data.error?.message ?? "That could not be saved." },
          ],
        );
        return;
      }
      router.push("/promotions");
      router.refresh();
    } catch {
      setIssues([{ path: "form", message: "The console could not reach the server." }]);
    } finally {
      setBusy(false);
    }
  }

  async function archive(): Promise<void> {
    if (!promotionId) return;
    if (!window.confirm("Archive this promotion? Buyers can no longer apply it.")) return;
    setBusy(true);
    setIssues([]);
    try {
      const res = await fetch(`/api/promotions/${promotionId}`, { method: "DELETE" });
      const data = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) {
        setIssues([{ path: "form", message: data.error?.message ?? "That could not be archived." }]);
        return;
      }
      router.push("/promotions");
      router.refresh();
    } catch {
      setIssues([{ path: "form", message: "The console could not reach the server." }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="panel">
        <div className="row">
          <div>
            <label htmlFor="promo-code">Code</label>
            <input
              id="promo-code"
              value={state.code}
              onChange={(e) => set({ code: e.target.value.toUpperCase() })}
              placeholder="DIWALI10"
              maxLength={40}
            />
          </div>
          <div style={{ flex: 1 }}>
            <label htmlFor="promo-name">Name</label>
            <input
              id="promo-name"
              value={state.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="Diwali sale"
              maxLength={120}
            />
          </div>
          <div>
            <label htmlFor="promo-status">Status</label>
            <select
              id="promo-status"
              value={state.status}
              onChange={(e) => set({ status: e.target.value as PromotionFormState["status"] })}
            >
              {PROMOTION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="row">
          <div>
            <label htmlFor="promo-starts">Starts (IST, blank = immediately)</label>
            <input
              id="promo-starts"
              type="datetime-local"
              value={state.startsAt}
              onChange={(e) => set({ startsAt: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="promo-ends">Ends (IST, blank = never)</label>
            <input
              id="promo-ends"
              type="datetime-local"
              value={state.endsAt}
              onChange={(e) => set({ endsAt: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="promo-limit-total">Total uses (blank = unlimited)</label>
            <input
              id="promo-limit-total"
              value={state.usageLimitTotal}
              onChange={(e) => set({ usageLimitTotal: e.target.value })}
              inputMode="numeric"
              placeholder="100"
            />
          </div>
          <div>
            <label htmlFor="promo-limit-customer">Uses per customer</label>
            <input
              id="promo-limit-customer"
              value={state.usageLimitPerCustomer}
              onChange={(e) => set({ usageLimitPerCustomer: e.target.value })}
              inputMode="numeric"
              placeholder="1"
            />
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Conditions</h2>
        <p className="muted">All conditions must hold. No conditions = always applicable.</p>
        {state.conditions.map((row, i) => (
          <div className="row" key={i}>
            <select
              aria-label={`Condition ${i + 1} type`}
              value={row.type}
              onChange={(e) =>
                setCondition(i, blankConditionRow(e.target.value as ConditionRow["type"]))
              }
            >
              {(Object.keys(CONDITION_LABELS) as ConditionRow["type"][]).map((t) => (
                <option key={t} value={t}>
                  {CONDITION_LABELS[t]}
                </option>
              ))}
            </select>

            {row.type === "cart_subtotal_min" && (
              <input
                aria-label={`Condition ${i + 1} minimum subtotal in rupees`}
                value={row.rupees}
                onChange={(e) => setCondition(i, { ...row, rupees: e.target.value })}
                inputMode="decimal"
                placeholder="₹ 999"
              />
            )}
            {(row.type === "contains_product" || row.type === "contains_category") && (
              <input
                aria-label={`Condition ${i + 1} ids`}
                style={{ flex: 1 }}
                value={row.ids}
                onChange={(e) => setCondition(i, { ...row, ids: e.target.value })}
                placeholder="Comma-separated ids"
              />
            )}
            {row.type === "customer_segment" && (
              <>
                <input
                  aria-label={`Condition ${i + 1} segment id`}
                  value={row.segmentId}
                  onChange={(e) => setCondition(i, { ...row, segmentId: e.target.value })}
                  placeholder="Segment id"
                />
                <span className="muted">Not evaluated until Phase 4 — coupon will not apply.</span>
              </>
            )}
            {row.type === "channel" &&
              ORDER_CHANNELS.map((channel: OrderChannel) => (
                <label key={channel} style={{ fontWeight: "normal" }}>
                  <input
                    type="checkbox"
                    checked={row.channels.includes(channel)}
                    onChange={(e) =>
                      setCondition(i, {
                        ...row,
                        channels: e.target.checked
                          ? [...row.channels, channel]
                          : row.channels.filter((c) => c !== channel),
                      })
                    }
                  />{" "}
                  {channel}
                </label>
              ))}

            <button
              type="button"
              className="chip"
              onClick={() => set({ conditions: removeAt(state.conditions, i) })}
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          className="chip"
          onClick={() => set({ conditions: [...state.conditions, blankConditionRow("cart_subtotal_min")] })}
        >
          Add condition
        </button>
      </div>

      <div className="panel">
        <h2>Effects</h2>
        {state.effects.map((row, i) => (
          <div className="row" key={i}>
            <select
              aria-label={`Effect ${i + 1} type`}
              value={row.type}
              onChange={(e) => setEffect(i, blankEffectRow(e.target.value as EffectRow["type"]))}
            >
              {(Object.keys(EFFECT_LABELS) as EffectRow["type"][]).map((t) => (
                <option key={t} value={t}>
                  {EFFECT_LABELS[t]}
                </option>
              ))}
            </select>

            {row.type === "flat_off" && (
              <input
                aria-label={`Effect ${i + 1} amount in rupees`}
                value={row.rupees}
                onChange={(e) => setEffect(i, { ...row, rupees: e.target.value })}
                inputMode="decimal"
                placeholder="₹ 100"
              />
            )}
            {row.type === "percent_off" && (
              <>
                <input
                  aria-label={`Effect ${i + 1} percentage`}
                  value={row.percent}
                  onChange={(e) => setEffect(i, { ...row, percent: e.target.value })}
                  inputMode="decimal"
                  placeholder="10%"
                />
                <input
                  aria-label={`Effect ${i + 1} maximum discount in rupees`}
                  value={row.maxRupees}
                  onChange={(e) => setEffect(i, { ...row, maxRupees: e.target.value })}
                  inputMode="decimal"
                  placeholder="Max ₹ (optional)"
                />
              </>
            )}
            {row.type === "buy_x_get_y" && (
              <>
                <input
                  aria-label={`Effect ${i + 1} buy quantity`}
                  value={row.buyQty}
                  onChange={(e) => setEffect(i, { ...row, buyQty: e.target.value })}
                  inputMode="numeric"
                  placeholder="Buy qty"
                />
                <input
                  aria-label={`Effect ${i + 1} get quantity`}
                  value={row.getQty}
                  onChange={(e) => setEffect(i, { ...row, getQty: e.target.value })}
                  inputMode="numeric"
                  placeholder="Get qty free"
                />
                <input
                  aria-label={`Effect ${i + 1} variant ids`}
                  style={{ flex: 1 }}
                  value={row.ids}
                  onChange={(e) => setEffect(i, { ...row, ids: e.target.value })}
                  placeholder="Free-variant ids, comma-separated"
                />
              </>
            )}

            <button
              type="button"
              className="chip"
              onClick={() => set({ effects: removeAt(state.effects, i) })}
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          className="chip"
          onClick={() => set({ effects: [...state.effects, blankEffectRow("flat_off")] })}
        >
          Add effect
        </button>
      </div>

      {issues.length > 0 && (
        <ul className="error">
          {issues.map((issue, i) => (
            <li key={`${issue.path}-${i}`}>
              {issue.path === "form" ? "" : `${issue.path}: `}
              {issue.message}
            </li>
          ))}
        </ul>
      )}

      <div className="toolbar" style={{ marginTop: 8 }}>
        <button type="submit" disabled={!canWrite || busy}>
          {busy ? "Saving…" : mode === "create" ? "Create promotion" : "Save changes"}
        </button>
        {mode === "edit" && (
          <button type="button" className="chip" onClick={archive} disabled={!canWrite || busy}>
            Archive
          </button>
        )}
      </div>
    </form>
  );
}
