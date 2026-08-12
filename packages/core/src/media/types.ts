/**
 * Storage adapter contract.
 *
 * The media pipeline needs somewhere to put bytes. Production is
 * Cloudflare R2; local development has no R2 and must not need one.
 *
 * This is an adapter contract with drivers, exactly like carriers —
 * nine courier providers behind one contract, none of them hardcoded
 * into the platform. Here: local filesystem and S3-compatible object
 * storage behind one contract.
 */

export type StoredObject = {
  key: string;
  byteSize: number;
  contentType: string;
};

export type StorageAdapter = {
  readonly driver: string;
  put(
    key: string,
    body: Buffer,
    opts: { contentType: string; cacheControl?: string },
  ): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  /** Public URL if the driver serves one; null when the app must proxy. */
  publicUrl(key: string): string | null;
};

export class StorageError extends Error {
  readonly driver: string;
  readonly retryable: boolean;

  constructor(opts: { driver: string; message: string; retryable: boolean }) {
    super(`[${opts.driver}] ${opts.message}`);
    this.name = "StorageError";
    this.driver = opts.driver;
    this.retryable = opts.retryable;
  }
}
