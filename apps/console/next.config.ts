import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,

  // Workspace packages ship TypeScript source, no build step.
  transpilePackages: ["@platform/core", "@platform/db", "@platform/integrations"],

  // Native/CJS server libraries that must not be bundled into the server
  // chunks. sharp is not here because it lives in the worker, not the
  // console — the console only enqueues.
  serverExternalPackages: ["bullmq", "ioredis", "@aws-sdk/client-s3"],

  // The console is authenticated and mutating. Nothing here is cacheable
  // and nothing here should ever be framed.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Cache-Control", value: "no-store, max-age=0" },
        ],
      },
    ];
  },
};

export default config;
