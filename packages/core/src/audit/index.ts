import { auditLog, withTenant } from "@platform/db";
import type { ActorType, Tx } from "@platform/db";

/**
 * Audit logging.
 *
 * Required for staff accountability, and independently required to make
 * support impersonation defensible once platform staff can enter any
 * merchant's console.
 *
 * The table has no UPDATE or DELETE grant (packages/db/src/rls.ts), so
 * append-only is enforced by database privilege rather than convention.
 */

export type AuditEntry = {
  actorType: ActorType;
  actorUserId?: string | null;
  action: string; // 'order.status_changed', 'settings.payment_updated'
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
};

/**
 * Write inside an existing transaction — the strongly preferred form.
 *
 * Passing the caller's `tx` makes the audit record atomic with the
 * change it describes: either both land or neither does. An audit log
 * that can disagree with the data is worse than none, because it is
 * trusted.
 */
export async function recordAudit(
  tx: Tx,
  tenantId: string,
  entry: AuditEntry,
): Promise<void> {
  await tx.insert(auditLog).values({
    tenantId,
    actorType: entry.actorType,
    actorUserId: entry.actorUserId ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    ip: entry.ip ?? null,
    userAgent: entry.userAgent?.slice(0, 512) ?? null,
    requestId: entry.requestId ?? null,
  });
}

/** Standalone write when there is no surrounding transaction. */
export async function recordAuditStandalone(
  tenantId: string,
  entry: AuditEntry,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.insert(auditLog).values({
      tenantId,
      actorType: entry.actorType,
      actorUserId: entry.actorUserId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      before: entry.before ?? null,
      after: entry.after ?? null,
      ip: entry.ip ?? null,
      userAgent: entry.userAgent?.slice(0, 512) ?? null,
      requestId: entry.requestId ?? null,
    });
  });
}
