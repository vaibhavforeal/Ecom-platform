import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type { StorageAdapter, StoredObject } from "@platform/core";
import { StorageError } from "@platform/core";

/**
 * S3-compatible storage driver.
 *
 * Drives Cloudflare R2, AWS S3, MinIO, and Backblaze through the same code.
 * The driver name is "s3", not "r2" — this is vendor-neutral by design.
 */

export type S3Config = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Public URL base for this bucket, if CDN-fronted. */
  publicUrlBase?: string;
  /**
   * Path-style addressing (endpoint.com/bucket/key instead of
   * bucket.endpoint.com/key). Required for MinIO and most self-hosted
   * S3; harmless for R2. The SDK default (virtual-hosted) stays for
   * anything that does not opt in.
   */
  forcePathStyle?: boolean;
};

export function createS3Driver(config: S3Config): StorageAdapter {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle ?? false,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return {
    driver: "s3",

    async put(key, body, opts): Promise<StoredObject> {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: key,
            Body: body,
            ContentType: opts.contentType,
            CacheControl: opts.cacheControl,
          }),
        );

        return {
          key,
          byteSize: body.length,
          contentType: opts.contentType,
        };
      } catch (err) {
        throw new StorageError({
          driver: "s3",
          message: `Failed to put ${key}: ${err}`,
          retryable: isRetryable(err),
        });
      }
    },

    async get(key): Promise<Buffer> {
      try {
        const response = await client.send(
          new GetObjectCommand({
            Bucket: config.bucket,
            Key: key,
          }),
        );

        if (!response.Body) {
          throw new StorageError({
            driver: "s3",
            message: `Key ${key} returned no body`,
            retryable: false,
          });
        }

        const chunks: Uint8Array[] = [];
        for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
          chunks.push(chunk);
        }

        return Buffer.concat(chunks);
      } catch (err: unknown) {
        const isNotFound =
          err &&
          typeof err === "object" &&
          "name" in err &&
          err.name === "NoSuchKey";

        throw new StorageError({
          driver: "s3",
          message: isNotFound ? `Key ${key} not found` : `Failed to get ${key}: ${err}`,
          retryable: isRetryable(err),
        });
      }
    },

    async delete(key): Promise<void> {
      try {
        await client.send(
          new DeleteObjectCommand({
            Bucket: config.bucket,
            Key: key,
          }),
        );
      } catch (err) {
        throw new StorageError({
          driver: "s3",
          message: `Failed to delete ${key}: ${err}`,
          retryable: isRetryable(err),
        });
      }
    },

    async exists(key): Promise<boolean> {
      try {
        await client.send(
          new HeadObjectCommand({
            Bucket: config.bucket,
            Key: key,
          }),
        );
        return true;
      } catch (err: unknown) {
        const isNotFound =
          err &&
          typeof err === "object" &&
          "name" in err &&
          (err.name === "NoSuchKey" || err.name === "NotFound");

        if (isNotFound) return false;

        throw new StorageError({
          driver: "s3",
          message: `Failed to check existence of ${key}: ${err}`,
          retryable: isRetryable(err),
        });
      }
    },

    publicUrl(key): string | null {
      if (!config.publicUrlBase) return null;
      const base = config.publicUrlBase.endsWith("/")
        ? config.publicUrlBase.slice(0, -1)
        : config.publicUrlBase;
      return `${base}/${key}`;
    },
  };
}

/**
 * Which S3 errors are worth retrying.
 * Network failures and 5xx are transient; 4xx is not.
 */
function isRetryable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;

  // Network errors
  if ("name" in err && typeof err.name === "string") {
    const retryableNames = [
      "NetworkError",
      "TimeoutError",
      "RequestTimeout",
      "ServiceUnavailable",
      "InternalError",
      "SlowDown",
      "RequestThrottled",
    ];
    if (retryableNames.includes(err.name)) return true;
  }

  // HTTP status codes
  if ("$metadata" in err && err.$metadata && typeof err.$metadata === "object") {
    const meta = err.$metadata as { httpStatusCode?: number };
    if (meta.httpStatusCode) {
      const status = meta.httpStatusCode;
      return status === 429 || status === 408 || (status >= 500 && status < 600);
    }
  }

  return false;
}
