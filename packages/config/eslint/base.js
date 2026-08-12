// Shared ESLint flat config.
//
// The rules that matter here are not style rules. They are the two
// boundary rules that keep the architecture honest:
//
//   1. Nothing outside packages/db may import the raw database client.
//      Every query must go through withTenant() / withPlatform() so
//      tenant context is impossible to forget.
//
//   2. Domain modules may not reach into each other's internals.
//      This is the seam that lets a module become a service later
//      without a rewrite (PLATFORM_BLUEPRINT.md §1.2).
//
// If either rule ever becomes inconvenient, that is a signal about the
// design, not about the rule.

import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/drizzle/**"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@platform/db/src/client", "**/db/src/client"],
              message:
                "Never import the raw DB client. Use withTenant() or withPlatform() from @platform/db.",
            },
            {
              group: ["@platform/core/src/*/internal/*"],
              message:
                "Domain module internals are private. Import from the module's public index.",
            },
          ],
        },
      ],
    },
  },
);
