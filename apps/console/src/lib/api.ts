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
      { error: { code: err.code, message: err.publicMessage }, requestId },
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
