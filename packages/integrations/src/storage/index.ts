import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { StorageAdapter } from "@platform/core";
import { createLocalDriver } from "./local";
import { createS3Driver } from "./s3";

/**
 * Storage driver selection.
 *
 * Reads STORAGE_DRIVER (local | s3), defaulting to "local".
 *
 * CRITICAL: In production, defaulting to "local" is forbidden — if
 * NODE_ENV === "production" and STORAGE_DRIVER is unset, this throws
 * at startup rather than silently writing a production catalog's images
 * to a container-local filesystem that vanishes on redeploy.
 *
 * This is the fail-open trap: the safe branch (local dev) is the default,
 * and the unsafe one (ephemeral production filesystem) must be chosen
 * explicitly — which forces the choice to be noticed.
 */

let cached: StorageAdapter | undefined;

export function getStorage(): StorageAdapter {
  if (cached) return cached;

  // || not ??: a blank value in .env means "no decision", same as unset.
  const driver = process.env.STORAGE_DRIVER || "local";
  const isProduction = process.env.NODE_ENV === "production";

  if (isProduction && !process.env.STORAGE_DRIVER) {
    throw new Error(
      "STORAGE_DRIVER is required in production. Set it to 'local' only if you " +
        "understand that container-local storage is ephemeral and will be lost on " +
        "redeploy. For persistent storage, set STORAGE_DRIVER=s3 and configure " +
        "STORAGE_ENDPOINT, STORAGE_REGION, STORAGE_BUCKET, STORAGE_ACCESS_KEY_ID, " +
        "and STORAGE_SECRET_ACCESS_KEY.",
    );
  }

  if (driver === "local") {
    let root: string;
    if (process.env.MEDIA_LOCAL_ROOT) {
      root = process.env.MEDIA_LOCAL_ROOT;
    } else {
      // Default to <repo-root>/.media
      // In a pnpm workspace: packages/integrations/src/storage/index.ts
      // Resolve up to repo root (4 levels)
      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      root = path.resolve(currentDir, "../../../..", ".media");
    }
    cached = createLocalDriver(root);
  } else if (driver === "s3") {
    const endpoint = process.env.STORAGE_ENDPOINT;
    const region = process.env.STORAGE_REGION;
    const bucket = process.env.STORAGE_BUCKET;
    const accessKeyId = process.env.STORAGE_ACCESS_KEY_ID;
    const secretAccessKey = process.env.STORAGE_SECRET_ACCESS_KEY;
    const publicUrlBase = process.env.STORAGE_PUBLIC_URL_BASE;

    if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) {
      throw new Error(
        "S3 driver requires: STORAGE_ENDPOINT, STORAGE_REGION, STORAGE_BUCKET, " +
          "STORAGE_ACCESS_KEY_ID, STORAGE_SECRET_ACCESS_KEY",
      );
    }

    cached = createS3Driver({
      endpoint,
      region,
      bucket,
      accessKeyId,
      secretAccessKey,
      publicUrlBase,
      forcePathStyle: process.env.STORAGE_FORCE_PATH_STYLE === "true",
    });
  } else {
    throw new Error(`Unknown STORAGE_DRIVER: "${driver}". Must be "local" or "s3".`);
  }

  return cached;
}

export { createLocalDriver, createS3Driver };
export type { S3Config } from "./s3";
