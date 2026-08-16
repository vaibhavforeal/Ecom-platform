/**
 * D17 net settlement, as a pure function so the arithmetic is pinned by
 * a unit test rather than living inline in a server component.
 *
 * Razorpay's payment entity reports `fee` INCLUSIVE of GST: `tax` is
 * the GST component already INSIDE `fee`, not an additional charge
 * (fee=2360 / tax=360 paise on a ₹1,000 capture means ₹20 fee + ₹3.60
 * GST, and Razorpay settles ₹976.40 = 1000 − 23.60). Net settlement is
 * therefore gross − fee alone; subtracting `feeTaxPaise` again would
 * double-count the GST and disagree with the merchant's bank statement
 * on every captured payment. The GST component is display-only — a
 * parenthetical inside the fee, never a second subtraction.
 */
export function netSettlementPaise(payment: {
  status: string;
  amountPaise: number;
  feePaise: number | null;
}): number | null {
  if (payment.status !== "captured" || payment.feePaise === null) return null;
  return payment.amountPaise - payment.feePaise;
}
