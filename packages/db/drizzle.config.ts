import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: "../../.env" });

export default defineConfig({
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // Schema changes run as the migrator role, never as app_user.
    url: process.env.DATABASE_URL_MIGRATOR ?? "",
  },
  verbose: true,
  strict: true,
});
