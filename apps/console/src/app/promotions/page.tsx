import Link from "next/link";

import { can } from "@platform/core";
import { PROMOTION_STATUSES } from "@platform/core/promotions";
import type { PromotionStatus } from "@platform/core/promotions";
import { listPromotions } from "@platform/core/promotions/server";

import { requireActor } from "../../lib/session";
import { isoToIstLocal } from "./form-model";

export const dynamic = "force-dynamic";

/**
 * Every promotion and its state. Rules are data — this list shows the
 * envelope (code, window, limits); the row's page shows the rules.
 */

const PAGE_SIZE = 50;

type Search = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function formatWindow(startsAt: Date | null, endsAt: Date | null): string {
  if (!startsAt && !endsAt) return "Always";
  const from = startsAt ? isoToIstLocal(startsAt.toISOString()).replace("T", " ") : "…";
  const to = endsAt ? isoToIstLocal(endsAt.toISOString()).replace("T", " ") : "…";
  return `${from} → ${to}`;
}

export default async function PromotionsPage({ searchParams }: Search) {
  const actor = await requireActor();

  if (!can(actor, "promotions:read")) {
    return (
      <main>
        <h1>Promotions</h1>
        <p className="error">Your role does not include access to promotions.</p>
      </main>
    );
  }

  const params = await searchParams;
  const statusParam = first(params.status);
  const status = (PROMOTION_STATUSES as readonly string[]).includes(statusParam ?? "")
    ? (statusParam as PromotionStatus)
    : undefined;
  const page = Math.max(Number.parseInt(first(params.page) ?? "1", 10) || 1, 1);

  const { items, total } = await listPromotions(actor.tenantId, {
    status,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  const pages = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  const writable = can(actor, "promotions:write");
  const query = (p: number) => `/promotions?${status ? `status=${status}&` : ""}page=${p}`;

  return (
    <main>
      <nav className="crumbs">
        <Link href="/">Dashboard</Link> · <Link href="/products">Products</Link>
      </nav>

      <h1>Promotions</h1>
      <p className="muted">
        {total} {total === 1 ? "promotion" : "promotions"}
        {status ? ` · ${status}` : ""}
      </p>

      <div className="panel">
        <nav className="toolbar">
          <Link href="/promotions" className="chip" aria-current={!status ? "page" : undefined}>
            All
          </Link>
          {PROMOTION_STATUSES.map((s) => (
            <Link
              key={s}
              href={`/promotions?status=${s}`}
              className="chip"
              aria-current={status === s ? "page" : undefined}
            >
              {s}
            </Link>
          ))}
          {writable && (
            <Link href="/promotions/new" className="chip">
              New promotion
            </Link>
          )}
        </nav>
      </div>

      {items.length === 0 ? (
        <div className="panel">
          <p className="muted">
            {status ? `No ${status} promotions.` : "No promotions yet. Create the first one."}
          </p>
        </div>
      ) : (
        <div className="panel">
          <table className="grid">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Status</th>
                <th>Window (IST)</th>
                <th style={{ textAlign: "right" }}>Limits</th>
              </tr>
            </thead>
            <tbody>
              {items.map((promo) => (
                <tr key={promo.id}>
                  <td>
                    <Link href={`/promotions/${promo.id}`}>
                      <code>{promo.code}</code>
                    </Link>
                  </td>
                  <td>{promo.name}</td>
                  <td>
                    <span className={`badge badge-${promo.status}`}>{promo.status}</span>
                  </td>
                  <td className="muted">{formatWindow(promo.startsAt, promo.endsAt)}</td>
                  <td style={{ textAlign: "right" }} className="muted">
                    {promo.usageLimitTotal ?? "∞"} total · {promo.usageLimitPerCustomer ?? "∞"}
                    /customer
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <nav className="pagination" aria-label="Pagination">
          {page > 1 && (
            <Link href={query(page - 1)} rel="prev">
              ← Previous
            </Link>
          )}
          <span className="muted">
            Page {page} of {pages}
          </span>
          {page < pages && (
            <Link href={query(page + 1)} rel="next">
              Next →
            </Link>
          )}
        </nav>
      )}
    </main>
  );
}
