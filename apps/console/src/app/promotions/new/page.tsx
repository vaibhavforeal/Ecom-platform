import Link from "next/link";
import { redirect } from "next/navigation";

import { can } from "@platform/core";

import { requireActor } from "../../../lib/session";
import { blankPromotion } from "../form-model";
import { PromotionForm } from "../PromotionForm";

export const dynamic = "force-dynamic";

export default async function NewPromotionPage() {
  const actor = await requireActor();
  // The route handler checks this too — that is the one that matters.
  // This only avoids rendering a form that cannot be submitted.
  if (!can(actor, "promotions:write")) redirect("/promotions");

  return (
    <main>
      <nav className="crumbs">
        <Link href="/promotions">Promotions</Link> · New
      </nav>
      <h1>New promotion</h1>

      <PromotionForm mode="create" initial={blankPromotion()} canWrite />
    </main>
  );
}
