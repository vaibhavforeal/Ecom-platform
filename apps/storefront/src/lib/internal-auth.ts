import { timingSafeEqual } from "node:crypto";

/**
 * The shared secret guarding the storefront's internal endpoints.
 *
 * Same secret and same header as the console's
 * `/api/internal/verify-domain`, deliberately: one internal credential
 * to rotate, not two, and one auth scheme for a reviewer to check.
 *
 * WHICH WAY ROUND THE ENVIRONMENT CHECK RUNS
 *
 * Several modules in this repo gate on `NODE_ENV === "production"` and
 * take the permissive branch otherwise — which means an UNSET NODE_ENV
 * silently ships the insecure behaviour, and that is precisely how
 * `next build` came to run with a development NODE_ENV for months (see
 * the traps list in PROJECT_STATUS.md). So the strict behaviour is the
 * DEFAULT here and the relaxed one needs an explicit opt-in: only a
 * NODE_ENV of exactly "development" or "test" skips the startup check.
 *
 * And even under that opt-in the endpoint does not open up. A missing
 * secret makes `isAuthorisedInternalRequest` return false for every
 * caller — it never means "let everyone in".
 */
const RELAXED_ENVIRONMENTS = new Set(["development", "test"]);

/** The configured secret, or null when there is none. */
export function internalSecret(): string | null {
  return process.env.INTERNAL_API_SECRET || null;
}

/**
 * Refuses to run without the secret. Called from `instrumentation.ts`,
 * so it fires once when the server boots rather than on the first
 * request to an endpoint nobody may notice is broken.
 *
 * Crashing a container at boot is the cheap failure. The expensive one
 * is a storefront that starts, serves fine, and quietly cannot be
 * purged — which reads as "the cache bug is back" months later.
 */
export function assertInternalSecretConfigured(): void {
  if (internalSecret() !== null) return;
  if (RELAXED_ENVIRONMENTS.has(process.env.NODE_ENV ?? "")) return;

  throw new Error(
    "INTERNAL_API_SECRET is not set. The storefront's internal endpoints refuse " +
      "every request without it, so catalog edits would never be purged from the " +
      "cache. Refusing to start.",
  );
}

/**
 * Constant-time check of the presented secret.
 *
 * Lengths are compared first because `timingSafeEqual` throws on a
 * length mismatch rather than returning false, and the length of a
 * secret is not the secret.
 */
export function isAuthorisedInternalRequest(req: Request): boolean {
  const expected = internalSecret();
  if (expected === null) return false;

  const provided = Buffer.from(req.headers.get("x-internal-secret") ?? "");
  const wanted = Buffer.from(expected);

  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}
