import { NextResponse } from "next/server";

import { AppError, resolveTenantByHost } from "@platform/core";
import type { ResolvedTenant } from "@platform/core";
import type { z } from "zod";

/**
 * Plumbing for the storefront's buyer-facing API routes (cart,
 * serviceability; B-INT's checkout route reuses it).
 *
 * These routes have NO session actor (spec §7): the tenant comes from
 * the request's Host — resolved off the Request object itself rather
 * than next/headers, so a handler is a plain (Request) => Response
 * function that integration tests can call directly. The error envelope
 * is the same `{ error: { code, message, details? }, requestId }` the
 * console emits, so every form has one renderer.
 */

/** Buyer JSON payloads are tiny; anything near this is not a cart action. */
export const MAX_BUYER_JSON_BYTES = 64 * 1024;

export function newRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Host → tenant for a buyer request. Suspended/churned tenants read as
 * absent — a lapsed subscription must not keep transacting, and must not
 * look different from an unknown host to a probe.
 */
export async function resolveBuyerTenant(req: Request): Promise<ResolvedTenant | null> {
  // x-forwarded-host is set by Caddy; `host` is the direct-connection
  // fallback used in local development (same order as lib/tenant.ts).
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const tenant = await resolveTenantByHost(host);
  if (!tenant) return null;
  if (tenant.status === "suspended" || tenant.status === "churned") return null;
  return tenant;
}

export function tenantNotFound(requestId: string): NextResponse {
  return NextResponse.json(
    { error: { code: "not_found", message: "Store not found." }, requestId },
    { status: 404 },
  );
}

/** One place where buyer-route errors become responses (console parity). */
export function errorResponse(err: unknown, requestId: string): NextResponse {
  if (err instanceof AppError) {
    console.warn(
      JSON.stringify({ level: "warn", requestId, code: err.code, message: err.message }),
    );
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.publicMessage,
          ...(err.details === undefined ? {} : { details: err.details }),
        },
        requestId,
      },
      { status: err.status },
    );
  }

  console.error(JSON.stringify({ level: "error", requestId, message: String(err) }), err);
  return NextResponse.json(
    { error: { code: "internal_error", message: "Something went wrong." }, requestId },
    { status: 500 },
  );
}

/** zod failures flattened to the same {path, message} shape as the domain's. */
export function zodIssues(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.map((issue) => ({
    path: issue.path.join(".") || "body",
    message: issue.message,
  }));
}

/**
 * Bounded read + JSON parse + zod parse, returning either the parsed
 * payload or the response to send. Counted off the socket, not trusted
 * from Content-Length (absent on chunked/H2 requests).
 */
export async function parseBuyerBody<TSchema extends z.ZodTypeAny>(
  req: Request,
  schema: TSchema,
  requestId: string,
): Promise<{ ok: true; data: z.infer<TSchema> } | { ok: false; response: NextResponse }> {
  const body = req.body;
  let raw: Uint8Array | null = null;

  if (body) {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_BUYER_JSON_BYTES) {
        await reader.cancel().catch(() => undefined);
        return {
          ok: false,
          response: NextResponse.json(
            {
              error: {
                code: "payload_too_large",
                message: `Requests must be ${MAX_BUYER_JSON_BYTES} bytes or smaller.`,
              },
              requestId,
            },
            { status: 413 },
          ),
        };
      }
      chunks.push(value);
    }
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    raw = joined;
  }

  let parsedJson: unknown = null;
  if (raw && raw.byteLength > 0) {
    try {
      parsedJson = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return {
        ok: false,
        response: NextResponse.json(
          { error: { code: "invalid_json", message: "Send a JSON body." }, requestId },
          { status: 400 },
        ),
      };
    }
  }

  const parsed = schema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      ok: false,
      response: NextResponse.json(
        {
          error: {
            code: "invalid_payload",
            message: "Some fields need attention.",
            details: { issues: zodIssues(parsed.error) },
          },
          requestId,
        },
        { status: 422 },
      ),
    };
  }

  return { ok: true, data: parsed.data };
}
