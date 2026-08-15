import type { Role } from "@platform/db";

import { ForbiddenError } from "../errors";

/**
 * Permission model.
 *
 * Roles map to permission SETS, and checks are always against a
 * permission, never against a role. `if (role === 'owner')` scattered
 * through the codebase is how you end up unable to offer custom roles in
 * Phase 2 without touching every call site.
 *
 * See PLATFORM_BLUEPRINT.md §7.2.
 */

export const PERMISSIONS = [
  "catalog:read",
  "catalog:write",
  "inventory:read",
  "inventory:write",
  "orders:read",
  "orders:write",
  "orders:cancel",
  "orders:refund",
  "pos:operate",
  "customers:read",
  "customers:write",
  "marketing:read",
  "marketing:write",
  "promotions:read",
  "promotions:write",
  "analytics:read",
  "settings:read",
  "settings:write",
  "staff:read",
  "staff:write",
  "payments:configure",
  "payments:write",
  "domains:manage",
  "billing:manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ALL = PERMISSIONS as readonly Permission[];

/**
 * Default permission sets. `permissionOverrides` on tenant_members can
 * grant or revoke on top of these per member.
 *
 * Deliberate choices worth noting:
 *  · order_processor cannot refund. Refunds move money; fulfilment does not.
 *  · cashier cannot read analytics. A till operator does not need revenue.
 *  · only owner touches payments, billing and domains — the three that
 *    can take the store offline or redirect its money. `payments:write`
 *    (gateway credentials) is in that class, alongside payments:configure.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: ALL,

  manager: ALL.filter(
    (p) => p !== "billing:manage" && p !== "payments:configure" && p !== "payments:write",
  ),

  catalog_manager: [
    "catalog:read",
    "catalog:write",
    "inventory:read",
    "inventory:write",
    "analytics:read",
    "settings:read",
  ],

  order_processor: [
    "orders:read",
    "orders:write",
    "orders:cancel",
    "catalog:read",
    "inventory:read",
    "customers:read",
    "settings:read",
  ],

  cashier: [
    "pos:operate",
    "orders:read",
    "orders:write",
    "catalog:read",
    "inventory:read",
    "customers:read",
    "customers:write",
  ],
};

export type PermissionOverrides = Partial<Record<Permission, boolean>>;

/** Effective permissions = role defaults, then per-member overrides. */
export function effectivePermissions(
  role: Role,
  overrides: PermissionOverrides = {},
): Set<Permission> {
  const set = new Set<Permission>(ROLE_PERMISSIONS[role]);
  for (const [perm, granted] of Object.entries(overrides)) {
    if (!(PERMISSIONS as readonly string[]).includes(perm)) continue;
    if (granted) set.add(perm as Permission);
    else set.delete(perm as Permission);
  }
  return set;
}

export function can(
  actor: { permissions: Set<Permission> },
  permission: Permission,
): boolean {
  return actor.permissions.has(permission);
}

/**
 * Throwing variant for server-side use.
 *
 * Hiding a menu item in React is presentation. This is the check that
 * actually matters, and it must run on the server for every mutation —
 * the client is not a security boundary.
 */
export function assertCan(
  actor: { permissions: Set<Permission>; userId: string },
  permission: Permission,
): void {
  if (!actor.permissions.has(permission)) {
    throw new ForbiddenError(`User ${actor.userId} lacks ${permission}`);
  }
}

/** Roles that must hold a second factor before Phase 2 (blueprint §7.1). */
export const ROLES_REQUIRING_MFA: readonly Role[] = ["owner", "manager"];

export function requiresMfa(role: Role): boolean {
  return ROLES_REQUIRING_MFA.includes(role);
}
