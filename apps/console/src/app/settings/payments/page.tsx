import Link from "next/link";

import { can, primaryHostname } from "@platform/core";
import { getPaymentAccountView } from "@platform/core/payments/server";
import { availablePaymentProviders } from "@platform/integrations/payments";

import { requireActor } from "../../../lib/session";
import { PaymentsSettingsForm } from "./PaymentsSettingsForm";

export const dynamic = "force-dynamic";

/**
 * Gateway credentials (BYOG). The page hands the client form a
 * fingerprint-only view — secrets are write-only and never come back
 * from the server in any shape (D7/D19). The provider list is computed
 * HERE with the registry's fail-closed rule, so a production console
 * never offers the mock gateway.
 */
export default async function PaymentSettingsPage() {
  const actor = await requireActor();

  if (!can(actor, "payments:write")) {
    return (
      <main>
        <h1>Payments</h1>
        <p className="error">
          Only the store owner can manage payment gateway credentials.
        </p>
      </main>
    );
  }

  const account = await getPaymentAccountView(actor.tenantId);
  const host = await primaryHostname(actor.tenantId);

  return (
    <main>
      <nav className="crumbs">
        <Link href="/">Dashboard</Link> / <Link href="/settings">Settings</Link>
      </nav>

      <h1>Payments</h1>

      <PaymentsSettingsForm
        account={
          account
            ? {
                providerCode: account.providerCode,
                label: account.label,
                publicKeyId: account.publicKeyId,
                credentialFingerprint: account.credentialFingerprint,
                isEnabled: account.isEnabled,
                lastVerifiedAt: account.lastVerifiedAt?.toISOString() ?? null,
                lastError: account.lastError,
              }
            : null
        }
        webhookUrl={host ? `https://${host}/api/payments/webhook` : null}
        providers={availablePaymentProviders()}
      />
    </main>
  );
}
