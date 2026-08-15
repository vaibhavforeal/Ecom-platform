import { describe, expect, it } from "vitest";

import { netSettlementPaise } from "../src/lib/settlement";

/**
 * D17 pin: Razorpay's `fee` field INCLUDES GST — `tax` is the component
 * inside the fee, not an additional charge. Net settlement is
 * gross − fee, full stop. The regression this guards: subtracting the
 * fee GST a second time (net = amount − fee − feeTax), which understates
 * settlement by the GST on every captured payment and breaks bank
 * reconciliation. `netSettlementPaise` deliberately does not even take
 * `feeTaxPaise` — the GST component is display-only.
 */
describe("netSettlementPaise (D17)", () => {
  it("₹1,000 captured with fee ₹23.60 (incl. ₹3.60 GST) settles ₹976.40 — GST subtracted once, inside the fee", () => {
    // Razorpay doc example shape: amount 100000, fee 2360, tax 360.
    const net = netSettlementPaise({ status: "captured", amountPaise: 100_000, feePaise: 2360 });
    expect(net).toBe(97_640); // NOT 97,280 — that would double-count the ₹3.60 GST
  });

  it("matches Razorpay's own worked examples (fee=236/tax=36 on 10000; fee=118/tax=18 on 5000)", () => {
    expect(netSettlementPaise({ status: "captured", amountPaise: 10_000, feePaise: 236 })).toBe(9_764);
    expect(netSettlementPaise({ status: "captured", amountPaise: 5_000, feePaise: 118 })).toBe(4_882);
  });

  it("renders nothing until captured with a known fee", () => {
    expect(netSettlementPaise({ status: "created", amountPaise: 100_000, feePaise: 2360 })).toBeNull();
    expect(netSettlementPaise({ status: "failed", amountPaise: 100_000, feePaise: 2360 })).toBeNull();
    expect(netSettlementPaise({ status: "captured", amountPaise: 100_000, feePaise: null })).toBeNull();
  });

  it("a zero fee settles the full amount", () => {
    expect(netSettlementPaise({ status: "captured", amountPaise: 100_000, feePaise: 0 })).toBe(100_000);
  });
});
