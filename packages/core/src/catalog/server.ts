/**
 * Catalog reads. SERVER ONLY.
 *
 * Split from the pure barrel because everything here reaches
 * `@platform/db` and therefore the postgres driver. Importing this from
 * a client component is a build error rather than a runtime surprise,
 * which is the point of the separation.
 */
export * from "./queries";
export * from "./search";
