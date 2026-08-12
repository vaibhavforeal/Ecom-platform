import { ROLES } from "@platform/db";
import { describe, expect, it } from "vitest";

import { ForbiddenError } from "../src/errors";
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  assertCan,
  can,
  effectivePermissions,
  requiresMfa,
} from "../src/identity/permissions";

describe("role permission matrix", () => {
  it("defines a permission set for every role", () => {
    for (const role of ROLES) {
      expect(ROLE_PERMISSIONS[role], `no permissions defined for ${role}`).toBeDefined();
    }
  });

  it("grants owner everything", () => {
    expect(new Set(ROLE_PERMISSIONS.owner)).toEqual(new Set(PERMISSIONS));
  });

  it("withholds money-moving permissions from non-owners", () => {
    // Only owner may reconfigure where the money goes or who is billed.
    for (const role of ROLES) {
      if (role === "owner") continue;
      expect(ROLE_PERMISSIONS[role]).not.toContain("payments:configure");
      expect(ROLE_PERMISSIONS[role]).not.toContain("billing:manage");
    }
  });

  it("lets order_processor fulfil but not refund", () => {
    // Fulfilment and refunds are different blast radii.
    expect(ROLE_PERMISSIONS.order_processor).toContain("orders:write");
    expect(ROLE_PERMISSIONS.order_processor).not.toContain("orders:refund");
  });

  it("does not give a cashier revenue visibility", () => {
    expect(ROLE_PERMISSIONS.cashier).toContain("pos:operate");
    expect(ROLE_PERMISSIONS.cashier).not.toContain("analytics:read");
  });

  it("does not let a catalog_manager touch orders", () => {
    expect(ROLE_PERMISSIONS.catalog_manager).not.toContain("orders:write");
    expect(ROLE_PERMISSIONS.catalog_manager).not.toContain("orders:read");
  });
});

describe("effectivePermissions", () => {
  it("returns role defaults with no overrides", () => {
    expect(effectivePermissions("cashier")).toEqual(new Set(ROLE_PERMISSIONS.cashier));
  });

  it("grants via override", () => {
    const perms = effectivePermissions("cashier", { "analytics:read": true });
    expect(perms.has("analytics:read")).toBe(true);
  });

  it("revokes via override", () => {
    const perms = effectivePermissions("order_processor", { "orders:cancel": false });
    expect(perms.has("orders:cancel")).toBe(false);
    expect(perms.has("orders:write")).toBe(true);
  });

  it("can strip an owner down", () => {
    const perms = effectivePermissions("owner", { "billing:manage": false });
    expect(perms.has("billing:manage")).toBe(false);
  });

  it("ignores unknown permission strings instead of trusting them", () => {
    // permissionOverrides is JSONB — treat its contents as untrusted.
    const perms = effectivePermissions("cashier", {
      "not:a:permission": true,
      "__proto__": true,
    } as never);
    expect(perms.has("not:a:permission" as never)).toBe(false);
    expect(perms).toEqual(new Set(ROLE_PERMISSIONS.cashier));
  });

  it("does not mutate the shared role definition", () => {
    const before = [...ROLE_PERMISSIONS.cashier];
    effectivePermissions("cashier", { "analytics:read": true });
    expect([...ROLE_PERMISSIONS.cashier]).toEqual(before);
  });
});

describe("can / assertCan", () => {
  const actor = { userId: "u1", permissions: effectivePermissions("order_processor") };

  it("allows a held permission", () => {
    expect(can(actor, "orders:read")).toBe(true);
    expect(() => assertCan(actor, "orders:read")).not.toThrow();
  });

  it("denies a permission not held", () => {
    expect(can(actor, "orders:refund")).toBe(false);
    expect(() => assertCan(actor, "orders:refund")).toThrow(ForbiddenError);
  });

  it("does not leak the permission name to the client", () => {
    try {
      assertCan(actor, "payments:configure");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as ForbiddenError).publicMessage).not.toContain("payments:configure");
      expect((err as ForbiddenError).message).toContain("payments:configure");
    }
  });
});

describe("MFA requirements", () => {
  it("requires a second factor for the roles that hold real power", () => {
    expect(requiresMfa("owner")).toBe(true);
    expect(requiresMfa("manager")).toBe(true);
    expect(requiresMfa("cashier")).toBe(false);
  });
});
