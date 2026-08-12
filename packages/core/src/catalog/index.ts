/**
 * Catalog domain logic — PURE, and therefore safe in a client bundle.
 *
 * Nothing here touches the database, and nothing here may start to:
 * `@platform/db` pulls in the postgres driver, which pulls in `net`,
 * `fs` and `perf_hooks`, and the build fails the moment a client
 * component imports this barrel. That is not a hypothetical — the PDP's
 * variant picker is a client component and imports exactly these
 * functions.
 *
 * Database-backed reads live at `@platform/core/catalog/server`.
 */
export * from "./slug";
export * from "./options";
export * from "./money";
export * from "./categories";
export * from "./sanitize-html";
