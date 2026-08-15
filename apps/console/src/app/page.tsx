import Link from "next/link";

import { storeSettings, tenants, eq, withPlatform, withTenant } from "@platform/db";
import { can, domainsForTenant } from "@platform/core";

import { requireActor } from "../lib/session";

export const dynamic = "force-dynamic";

/**
 * Phase 0 dashboard — proof that the substrate works end to end.
 *
 * Note the two different accessors below. Tenant settings go through
 * withTenant(), so PostgreSQL itself guarantees this page cannot render
 * another merchant's data even if the query were wrong. The tenant
 * record and domain list are control-plane reads, filtered explicitly.
 */
export default async function DashboardPage() {
  const actor = await requireActor();

  const settings = await withTenant(actor.tenantId, async (tx) =>
    tx.select().from(storeSettings),
  );

  const [tenant] = await withPlatform(async (tx) =>
    tx.select().from(tenants).where(eq(tenants.id, actor.tenantId)).limit(1),
  );

  const hosts = await domainsForTenant(actor.tenantId);

  return (
    <main>
      <h1>{tenant?.displayName ?? "Store"}</h1>
      <p className="muted">
        Signed in as {actor.name ?? actor.phoneE164} · {actor.role}
      </p>

      {(can(actor, "catalog:read") || can(actor, "settings:read") || can(actor, "inventory:read")) && (
        <nav className="toolbar">
          {can(actor, "catalog:read") && (
            <>
              <Link href="/products" className="chip">
                Products
              </Link>
              <Link href="/products/taxonomy" className="chip">
                Categories &amp; collections
              </Link>
            </>
          )}
          {can(actor, "inventory:read") && (
            <Link href="/inventory" className="chip">
              Inventory
            </Link>
          )}
          {can(actor, "settings:read") && (
            <Link href="/settings" className="chip">
              Settings
            </Link>
          )}
        </nav>
      )}

      <div className="panel">
        <h2 style={{ fontSize: 15, margin: "0 0 12px" }}>Tenant</h2>
        <dl>
          <dt>Tenant ID</dt>
          <dd>
            <code>{actor.tenantId}</code>
          </dd>
          <dt>Slug</dt>
          <dd>{tenant?.slug}</dd>
          <dt>Status</dt>
          <dd>{tenant?.status}</dd>
          <dt>Tax registration</dt>
          <dd>{tenant?.taxRegistrationType}</dd>
          <dt>Permissions</dt>
          <dd>{actor.permissions.size} granted</dd>
        </dl>
      </div>

      <div className="panel">
        <h2 style={{ fontSize: 15, margin: "0 0 12px" }}>Domains</h2>
        <dl>
          {hosts.map((d) => (
            <div key={d.id} style={{ display: "contents" }}>
              <dt>{d.isPrimary ? "Primary" : "Alias"}</dt>
              <dd>
                <code>{d.hostname}</code> {d.verifiedAt ? "· verified" : "· pending DNS"}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="panel">
        <h2 style={{ fontSize: 15, margin: "0 0 12px" }}>
          Store settings <span className="muted">(RLS-protected)</span>
        </h2>
        <dl>
          {settings.map((s) => (
            <div key={s.key} style={{ display: "contents" }}>
              <dt>
                <code>{s.key}</code>
              </dt>
              <dd>
                <code>{JSON.stringify(s.value)}</code>
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <form action="/api/auth/logout" method="post">
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
