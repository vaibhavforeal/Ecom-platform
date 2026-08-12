import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@platform/core", "@platform/db"],

  // The storefront serves arbitrary tenant hostnames, so it must never
  // assume its own origin. Any absolute URL is derived from the resolved
  // tenant's primary domain, never from an env var.
  poweredByHeader: false,

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default config;
