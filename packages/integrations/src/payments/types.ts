/**
 * The payment adapter contract, re-exported from the core PURE barrel —
 * the mirror of how carriers re-export their contract. Drivers in this
 * directory implement `PaymentGatewayAdapter`; nothing here may import
 * `@platform/db`'s root barrel (drivers run inside web requests and the
 * worker; they get credentials handed to them, never a connection).
 */

export { GATEWAY_EVENT_TYPES } from "@platform/core/payments";
export type {
  GatewayCredentials,
  GatewayEvent,
  GatewayKnownEventType,
  PaymentGatewayAdapter,
  PaymentProviderCode,
} from "@platform/core/payments";
