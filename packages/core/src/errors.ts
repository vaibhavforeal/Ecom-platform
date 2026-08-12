/**
 * Typed errors carrying an HTTP status and a client-safe message.
 *
 * The split between `message` (internal, logged) and `publicMessage`
 * (returned to the caller) is deliberate: auth failures must not tell an
 * attacker which half of the credential was wrong.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly publicMessage: string;

  constructor(opts: {
    code: string;
    message: string;
    status?: number;
    publicMessage?: string;
  }) {
    super(opts.message);
    this.name = new.target.name;
    this.code = opts.code;
    this.status = opts.status ?? 400;
    this.publicMessage = opts.publicMessage ?? opts.message;
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Not authenticated") {
    super({ code: "unauthorized", message, status: 401, publicMessage: "Not authenticated." });
  }
}

export class ForbiddenError extends AppError {
  constructor(message: string) {
    super({
      code: "forbidden",
      message,
      status: 403,
      publicMessage: "You do not have permission to do that.",
    });
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) {
    super({ code: "not_found", message: `${what} not found`, status: 404 });
  }
}

export class RateLimitedError extends AppError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super({
      code: "rate_limited",
      message: `Rate limited for ${retryAfterSeconds}s`,
      status: 429,
      publicMessage: "Too many attempts. Please try again shortly.",
    });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Every OTP failure mode returns this same error on purpose — wrong
 * code, expired code, too many attempts and no-such-challenge are
 * indistinguishable to the caller. Distinguishing them tells an attacker
 * whether a phone number is enrolled and whether a code is still live.
 */
export class InvalidOtpError extends AppError {
  constructor(internal: string) {
    super({
      code: "invalid_otp",
      message: `OTP rejected: ${internal}`,
      status: 401,
      publicMessage: "That code is not valid. Request a new one.",
    });
  }
}
