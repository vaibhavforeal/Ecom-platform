import { assertMockGatewayAllowed, mock } from "./mock";
import { razorpay } from "./razorpay";
import type { PaymentGatewayAdapter, PaymentProviderCode } from "./types";

/**
 * The payment gateway registry — the carrier registry's shape. Nothing
 * outside this directory knows which drivers exist; adding a provider is
 * one entry here plus one code in PAYMENT_PROVIDER_CODES.
 */
const REGISTRY: Record<PaymentProviderCode, PaymentGatewayAdapter> = {
  razorpay,
  mock,
};

/**
 * Resolve a provider code to its driver.
 *
 * The mock driver's gate FAILS CLOSED: it refuses when NODE_ENV is
 * 'production' OR unset (never "enable when dev") — a production
 * deployment that forgets to set NODE_ENV must not find a gateway that
 * pretends money moved.
 */
export function getPaymentAdapter(code: PaymentProviderCode): PaymentGatewayAdapter {
  const adapter = REGISTRY[code];
  if (!adapter) throw new Error(`Unknown payment provider: ${String(code)}`);
  if (code === "mock") assertMockGatewayAllowed();
  return adapter;
}

/**
 * Providers a merchant may connect — what the console's settings page
 * offers. Same fail-closed rule: mock is listed only when NODE_ENV is
 * set to something other than 'production'.
 */
export function availablePaymentProviders(): PaymentProviderCode[] {
  const env = process.env.NODE_ENV;
  const mockAllowed = Boolean(env) && env !== "production";
  return (Object.keys(REGISTRY) as PaymentProviderCode[]).filter(
    (code) => code !== "mock" || mockAllowed,
  );
}
