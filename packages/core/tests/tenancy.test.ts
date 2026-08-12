import { describe, expect, it } from "vitest";

import { isSearchIndexable } from "../src/tenancy/index";
import type { SearchIndexing, TenantStatus } from "@platform/db";

// ───────────────────────────────────────────────────────────────
// Search Indexing
// ───────────────────────────────────────────────────────────────

describe("isSearchIndexable", () => {
  // Truth table test: all modes × all statuses
  describe("truth table", () => {
    it("trial + auto → false", () => {
      expect(isSearchIndexable({ status: "trial", searchIndexing: "auto" })).toBe(false);
    });

    it("trial + indexed → true", () => {
      expect(isSearchIndexable({ status: "trial", searchIndexing: "indexed" })).toBe(true);
    });

    it("trial + noindex → false", () => {
      expect(isSearchIndexable({ status: "trial", searchIndexing: "noindex" })).toBe(false);
    });

    it("active + auto → true", () => {
      expect(isSearchIndexable({ status: "active", searchIndexing: "auto" })).toBe(true);
    });

    it("active + indexed → true", () => {
      expect(isSearchIndexable({ status: "active", searchIndexing: "indexed" })).toBe(true);
    });

    it("active + noindex → false", () => {
      expect(isSearchIndexable({ status: "active", searchIndexing: "noindex" })).toBe(false);
    });

    it("suspended + auto → false (platform override)", () => {
      expect(isSearchIndexable({ status: "suspended", searchIndexing: "auto" })).toBe(false);
    });

    it("suspended + indexed → false (platform override)", () => {
      expect(isSearchIndexable({ status: "suspended", searchIndexing: "indexed" })).toBe(false);
    });

    it("suspended + noindex → false", () => {
      expect(isSearchIndexable({ status: "suspended", searchIndexing: "noindex" })).toBe(false);
    });

    it("churned + auto → false (platform override)", () => {
      expect(isSearchIndexable({ status: "churned", searchIndexing: "auto" })).toBe(false);
    });

    it("churned + indexed → false (platform override)", () => {
      expect(isSearchIndexable({ status: "churned", searchIndexing: "indexed" })).toBe(false);
    });

    it("churned + noindex → false", () => {
      expect(isSearchIndexable({ status: "churned", searchIndexing: "noindex" })).toBe(false);
    });
  });

  describe("precedence rules", () => {
    it("suspended/churned override takes absolute precedence over indexed", () => {
      // This is the critical safety property: a suspended store with
      // searchIndexing="indexed" must still be noindex, not remain indexed.
      expect(isSearchIndexable({ status: "suspended", searchIndexing: "indexed" })).toBe(false);
      expect(isSearchIndexable({ status: "churned", searchIndexing: "indexed" })).toBe(false);
    });

    it("explicit indexed overrides auto for trial", () => {
      // A trial merchant who wants to be indexed can explicitly opt in
      expect(isSearchIndexable({ status: "trial", searchIndexing: "indexed" })).toBe(true);
    });

    it("explicit noindex overrides auto for active", () => {
      // An active merchant can explicitly opt out of indexing
      expect(isSearchIndexable({ status: "active", searchIndexing: "noindex" })).toBe(false);
    });

    it("auto mode indexes only active tenants", () => {
      expect(isSearchIndexable({ status: "active", searchIndexing: "auto" })).toBe(true);
      expect(isSearchIndexable({ status: "trial", searchIndexing: "auto" })).toBe(false);
      expect(isSearchIndexable({ status: "suspended", searchIndexing: "auto" })).toBe(false);
      expect(isSearchIndexable({ status: "churned", searchIndexing: "auto" })).toBe(false);
    });
  });

  describe("use cases", () => {
    it("trial merchant launching a store can be indexed", () => {
      // The original problem: a trial merchant wants to launch publicly
      const trial = { status: "trial" as TenantStatus, searchIndexing: "indexed" as SearchIndexing };
      expect(isSearchIndexable(trial)).toBe(true);
    });

    it("upgrading trial → active with auto stays indexed", () => {
      // Before upgrade: trial + auto = noindex
      expect(isSearchIndexable({ status: "trial", searchIndexing: "auto" })).toBe(false);
      // After upgrade: active + auto = indexed (no silent de-index)
      expect(isSearchIndexable({ status: "active", searchIndexing: "auto" })).toBe(true);
    });

    it("active merchant can explicitly de-index their store", () => {
      const merchant = { status: "active" as TenantStatus, searchIndexing: "noindex" as SearchIndexing };
      expect(isSearchIndexable(merchant)).toBe(false);
    });

    it("suspension de-indexes even if merchant set indexed", () => {
      // Platform safety: suspended stores must not linger in the index
      const suspended = { status: "suspended" as TenantStatus, searchIndexing: "indexed" as SearchIndexing };
      expect(isSearchIndexable(suspended)).toBe(false);
    });
  });
});
