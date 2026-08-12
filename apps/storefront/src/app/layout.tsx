import type { Metadata } from "next";
import type { ReactNode } from "react";

import { getTenant } from "../lib/tenant";

import "./globals.css";

/**
 * Metadata is per-tenant from the very first commit.
 *
 * A hardcoded title here would be the first violation of blueprint §0,
 * and the kind that survives to production because it looks harmless.
 */
export async function generateMetadata(): Promise<Metadata> {
  const tenant = await getTenant();
  if (!tenant) return { title: "Not found", robots: { index: false, follow: false } };

  return {
    title: { default: tenant.displayName, template: `%s · ${tenant.displayName}` },
    // Phase 1 replaces this with per-page SEO from the catalog's `seo`
    // column, plus JSON-LD, canonicals and per-host sitemaps (§6.2).
    robots:
      tenant.status === "active"
        ? { index: true, follow: true }
        : { index: false, follow: false },
  };
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
