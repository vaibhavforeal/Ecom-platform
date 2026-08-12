import { NextResponse } from "next/server";

import { AppError, RateLimitedError } from "@platform/core";

/**
 * One place where errors become responses.
 *
 * Only `publicMessage` crosses the wire. The internal message is logged
 * with the request id so support can correlate, but an attacker learns
 * nothing from a failed login beyond "that didn't work".
 */
export function errorResponse(err: unknown, requestId: string): NextResponse {
  if (err instanceof AppError) {
    console.warn(JSON.stringify({ level: "warn", requestId, code: err.code, message: err.message }));

    const headers: Record<string, string> = {};
    if (err instanceof RateLimitedError) {
      headers["Retry-After"] = String(err.retryAfterSeconds);
    }

    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.publicMessage,
          // Only when the error carries it. `details` is the field-level
          // breakdown a form needs to highlight the right input; errors
          // that do not set it (auth, rate limits) stay opaque, which is
          // the point of the split.
          ...(err.details === undefined ? {} : { details: err.details }),
        },
        requestId,
      },
      { status: err.status, headers },
    );
  }

  console.error(JSON.stringify({ level: "error", requestId, message: String(err) }), err);
  return NextResponse.json(
    { error: { code: "internal_error", message: "Something went wrong." }, requestId },
    { status: 500 },
  );
}

export function newRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Read the body, counting as we go, and hang up past the limit.
 *
 * App Router route handlers have no default body limit — `bodySizeLimit`
 * is a Server Actions setting — and Caddy sets no `request_body
 * max_size`, so `req.json()` and `req.formData()` will both happily
 * buffer whatever arrives. A `Content-Length` pre-check does NOT close
 * that: the header is absent on `Transfer-Encoding: chunked` and on
 * ordinary HTTP/2, and `Number(null ?? "0")` is 0, which passes every
 * comparison. Garbage in the header is `NaN`, which passes too. The only
 * number worth trusting is the one counted off the socket.
 */
export async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | "too_large" | null> {
  if (!body) return null;

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.byteLength;
    if (total > limit) {
      // Hang up rather than draining bytes already decided against.
      await reader.cancel().catch(() => undefined);
      return "too_large";
    }
    chunks.push(value);
  }

  // Joined by hand rather than with Buffer.concat: `BodyInit` excludes
  // SharedArrayBuffer-backed views, and a Buffer is a view into a shared
  // pool. Same single copy either way.
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}
