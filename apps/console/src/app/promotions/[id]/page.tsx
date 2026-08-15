import Link from "next/link";
import { notFound } from "next/navigation";

import { can } from "@platform/core";
import { getPromotion } from "@platform/core/promotions/server";

import { requireActor } from "../../../lib/session";
import { toFormState, toSerializable } from "../form-model";
import { PromotionForm } from "../PromotionForm";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function EditPromotionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await requireActor();
  const { id } = await params;

  // Shape-checked before it reaches a query: an id that is not a uuid
  // would otherwise come back as an opaque cast error rather than a 404.
  if (!UUID_RE.test(id)) notFound();

  if (!can(actor, "promotions:read")) {
    return (
      <main>
        <h1>Promotion</h1>
        <p className="error">Your role does not include access to promotions.</p>
      </main>
    );
  }

  const promotion = await getPromotion(actor.tenantId, id);
  // Another merchant's promotion is invisible under this tenant's RLS
  // context, so a cross-tenant id lands here as a plain 404.
  if (!promotion) notFound();

  return (
    <main>
      <nav className="crumbs">
        <Link href="/promotions">Promotions</Link> · {promotion.code}
      </nav>
      <h1>{promotion.name}</h1>
      <p className="muted">
        <code>{promotion.code}</code> · {promotion.status}
      </p>

      <PromotionForm
        mode="edit"
        promotionId={promotion.id}
        initial={toFormState(toSerializable(promotion))}
        canWrite={can(actor, "promotions:write")}
      />
    </main>
  );
}
