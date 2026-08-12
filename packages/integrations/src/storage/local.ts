import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { StorageAdapter, StoredObject } from "@platform/core";
import { StorageError } from "@platform/core";

/**
 * Local filesystem storage driver.
 *
 * For development only. Rooted at MEDIA_LOCAL_ROOT (default: <repo>/.media).
 *
 * SECURITY: Path traversal in this driver is arbitrary file write.
 * Every key is normalised and verified to be within the root.
 */

export function createLocalDriver(root: string): StorageAdapter {
  const normalizedRoot = path.resolve(root);

  /**
   * Verify that a key stays within the root after normalisation.
   * Rejects: "../../../etc/passwd", "/etc/passwd", "foo/../../../bar"
   */
  function safePath(key: string): string {
    const normalized = path.normalize(key);

    // Reject absolute paths
    if (path.isAbsolute(normalized)) {
      throw new StorageError({
        driver: "local",
        message: `Key "${key}" resolves to an absolute path`,
        retryable: false,
      });
    }

    // Reject keys that escape upward
    if (normalized.startsWith("..") || normalized.includes(`${path.sep}..`)) {
      throw new StorageError({
        driver: "local",
        message: `Key "${key}" attempts to escape the storage root`,
        retryable: false,
      });
    }

    const fullPath = path.join(normalizedRoot, normalized);
    const resolved = path.resolve(fullPath);

    // Final check: the resolved path must be within the root
    if (!resolved.startsWith(normalizedRoot + path.sep) && resolved !== normalizedRoot) {
      throw new StorageError({
        driver: "local",
        message: `Key "${key}" resolves outside the storage root`,
        retryable: false,
      });
    }

    return resolved;
  }

  return {
    driver: "local",

    async put(key, body, opts): Promise<StoredObject> {
      const fullPath = safePath(key);
      const dir = path.dirname(fullPath);

      try {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(fullPath, body);

        return {
          key,
          byteSize: body.length,
          contentType: opts.contentType,
        };
      } catch (err) {
        throw new StorageError({
          driver: "local",
          message: `Failed to write ${key}: ${err}`,
          retryable: false,
        });
      }
    },

    async get(key): Promise<Buffer> {
      const fullPath = safePath(key);

      try {
        return await fs.readFile(fullPath);
      } catch (err: unknown) {
        const isNotFound =
          err &&
          typeof err === "object" &&
          "code" in err &&
          err.code === "ENOENT";

        throw new StorageError({
          driver: "local",
          message: isNotFound ? `Key ${key} not found` : `Failed to read ${key}: ${err}`,
          retryable: false,
        });
      }
    },

    async delete(key): Promise<void> {
      const fullPath = safePath(key);

      try {
        await fs.unlink(fullPath);
      } catch (err: unknown) {
        // Deleting a non-existent file is idempotent success
        const isNotFound =
          err &&
          typeof err === "object" &&
          "code" in err &&
          err.code === "ENOENT";
        if (isNotFound) return;

        throw new StorageError({
          driver: "local",
          message: `Failed to delete ${key}: ${err}`,
          retryable: false,
        });
      }
    },

    async exists(key): Promise<boolean> {
      const fullPath = safePath(key);

      try {
        await fs.access(fullPath);
        return true;
      } catch {
        return false;
      }
    },

    publicUrl(_key): string | null {
      // Local driver serves nothing publicly — the app proxies.
      return null;
    },
  };
}
