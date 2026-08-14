import Link from "next/link";

import { can, isSearchIndexable } from "@platform/core";
import { eq, tenants, withPlatform } from "@platform/db";

import { requireActor } from "../../lib/session";
import { SearchIndexingForm } from "./SearchIndexingForm";

export const dynamic = "force-dynamic";

/**
 * Tenant settings. One control today — search-engine indexing — on a
 * page shaped so later settings have a home.
 *
 * The effective state is computed HERE with the real resolver and passed
 * down: the client never re-derives platform policy.
 */
export default async function SettingsPage() {
  const actor = await requireActor();

  if (!can(actor, "settings:read")) {
    return (
      <main>
        <h1>Settings</h1>
        <p className="error">Your role does not include access to settings.</p>
      </main>
    );
  }

  const [tenant] = await withPlatform(async (tx) =>
    tx
      .select({ status: tenants.status, searchIndexing: tenants.searchIndexing })
      .from(tenants)
      .where(eq(tenants.id, actor.tenantId))
      .limit(1),
  );

  if (!tenant) {
    return (
      <main>
        <h1>Settings</h1>
        <p className="error">This store could not be loaded.</p>
      </main>
    );
  }

  return (
    <main>
      <nav className="crumbs">
        <Link href="/">Dashboard</Link>
      </nav>

      <h1>Settings</h1>

      <SearchIndexingForm
        current={tenant.searchIndexing}
        status={tenant.status}
        indexable={isSearchIndexable(tenant)}
        canWrite={can(actor, "settings:write")}
      />
    </main>
  );
}
