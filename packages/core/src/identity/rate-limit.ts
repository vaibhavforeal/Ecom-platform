import { RateLimitedError } from "../errors";
import { platformKey, redis } from "../redis";

/**
 * Sliding-window rate limiting on Redis sorted sets.
 *
 * Fixed windows are trivially gamed: with a 5-per-hour fixed window, an
 * attacker sends 5 at 10:59 and 5 more at 11:00. A sliding window costs
 * one extra Redis command and closes that hole.
 */

export type RateLimitRule = {
  /** Stable identifier, e.g. 'otp:request:phone'. */
  name: string;
  limit: number;
  windowSeconds: number;
};

export async function consumeRateLimit(rule: RateLimitRule, subject: string): Promise<void> {
  const key = platformKey("rl", rule.name, subject);
  const now = Date.now();
  const windowStart = now - rule.windowSeconds * 1000;

  const results = await redis()
    .multi()
    .zremrangebyscore(key, 0, windowStart)
    .zcard(key)
    .zadd(key, now, `${now}-${Math.random().toString(36).slice(2, 10)}`)
    .expire(key, rule.windowSeconds)
    .exec();

  const countBefore = Number(results?.[1]?.[1] ?? 0);

  if (countBefore >= rule.limit) {
    // Remove the entry we just optimistically added so a blocked caller
    // cannot extend their own lockout by hammering the endpoint.
    await redis().zremrangebyrank(key, -1, -1);

    const oldest = await redis().zrange(key, 0, 0, "WITHSCORES");
    const oldestScore = Number(oldest[1] ?? now);
    const retryAfter = Math.max(
      1,
      Math.ceil((oldestScore + rule.windowSeconds * 1000 - now) / 1000),
    );
    throw new RateLimitedError(retryAfter);
  }
}

/**
 * OTP rate limits, layered.
 *
 * Per-phone stops targeting one victim. Per-IP stops enumerating many
 * victims from one host. The global limit is a blunt backstop against a
 * distributed run — an SMS flood is not just an attack on users, it is a
 * direct bill from the SMS provider.
 */
export const OTP_RATE_LIMITS = {
  perPhone: { name: "otp:request:phone", limit: 5, windowSeconds: 3600 },
  perIp: { name: "otp:request:ip", limit: 20, windowSeconds: 3600 },
  perPhoneBurst: { name: "otp:request:phone:burst", limit: 1, windowSeconds: 45 },
  verifyPerPhone: { name: "otp:verify:phone", limit: 10, windowSeconds: 900 },
  verifyPerIp: { name: "otp:verify:ip", limit: 50, windowSeconds: 900 },
} as const satisfies Record<string, RateLimitRule>;
