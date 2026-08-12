import { maskPhone } from "./otp";

/**
 * OTP delivery, behind an interface from day one.
 *
 * Phase 0 logs to the console. Phase 4 swaps in MSG91 — which cannot be
 * done in an afternoon, because Indian SMS requires TRAI DLT
 * registration of both the sender ID and every message template, and
 * carriers silently drop unregistered traffic. Start that paperwork now;
 * it is measured in weeks (PLATFORM_BLUEPRINT.md §5.2).
 */

export interface OtpDeliveryProvider {
  readonly name: string;
  send(input: { phoneE164: string; code: string; purpose: string }): Promise<void>;
}

/** Development provider. Refuses to run outside development. */
export const consoleOtpProvider: OtpDeliveryProvider = {
  name: "console",
  async send({ phoneE164, code, purpose }) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "consoleOtpProvider must never run in production — it prints login codes to the log.",
      );
    }
    console.log(
      `\n  ┌─ OTP ─────────────────────────────────\n` +
        `  │  to      ${maskPhone(phoneE164)}  (${phoneE164})\n` +
        `  │  purpose ${purpose}\n` +
        `  │  code    ${code}\n` +
        `  └───────────────────────────────────────\n`,
    );
  },
};

/**
 * MSG91 stub. Left unimplemented rather than half-implemented so it
 * fails loudly at boot instead of silently dropping logins in staging.
 */
export const msg91OtpProvider: OtpDeliveryProvider = {
  name: "msg91",
  async send() {
    throw new Error(
      "MSG91 provider not implemented. Requires MSG91_AUTH_KEY, MSG91_SENDER_ID and a " +
        "DLT-registered MSG91_DLT_TEMPLATE_ID. Scheduled for Phase 4.",
    );
  },
};

export function getOtpProvider(): OtpDeliveryProvider {
  const configured = process.env.OTP_PROVIDER ?? "console";
  switch (configured) {
    case "console":
      return consoleOtpProvider;
    case "msg91":
      return msg91OtpProvider;
    default:
      throw new Error(`Unknown OTP_PROVIDER: ${configured}`);
  }
}
