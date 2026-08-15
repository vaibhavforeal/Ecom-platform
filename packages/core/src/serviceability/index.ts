import { AppError } from "../errors";

/**
 * Serviceability — PURE barrel, safe for client bundles (the checkout
 * page validates pincodes client-side with the same regex).
 *
 * S0 SCHEMA SPINE: signatures FROZEN; bodies and the prefix map data
 * implemented by lot B4.
 */

export const PINCODE_RE = /^[1-9][0-9]{5}$/;

/**
 * GST state codes → names, the vocabulary `PINCODE_PREFIX_STATES` maps
 * into and the checkout form's state selector renders. Codes follow the
 * current GSTN list: "25" (Daman & Diu) and "28" (pre-bifurcation Andhra
 * Pradesh) are retired and deliberately absent — a buyer cannot select a
 * state that can no longer appear on a tax document.
 */
export const GST_STATE_NAMES: Record<string, string> = {
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman and Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
};

/**
 * Static 2-digit pincode prefix → allowed GST state codes (design D3).
 * Cross-checks the buyer-typed stateCode so the CGST/SGST-vs-IGST fork
 * never trusts typed input alone. Prefixes that legitimately span states
 * list EVERY legitimate code — safety over precision, never a false
 * refusal. An unknown prefix returns [] and the caller accepts the typed
 * state (fail-open on the cross-check ONLY; the serviceability policy
 * still applies).
 *
 * Derived from India Post's postal-circle allocation. The deliberate
 * multi-state rows: enclave union territories share a mainland state's
 * prefix (Puducherry's four districts sit inside TN/AP/Kerala ranges,
 * Lakshadweep inside Kerala's, Goa inside Maharashtra's, Diu/Daman/
 * Silvassa inside Gujarat's, A&N and Sikkim inside West Bengal's), the
 * UP/Uttarakhand and Bihar/Jharkhand bifurcations left their prefixes
 * interleaved, and "79" covers six North-Eastern states. Army postal
 * prefixes (90–99) and unallocated ranges are intentionally absent —
 * unknown means fail-open, not refusal.
 */
export const PINCODE_PREFIX_STATES: Record<string, readonly string[]> = {
  "11": ["07"], // Delhi
  "12": ["06"], // Haryana
  "13": ["06"], // Haryana
  "14": ["03"], // Punjab
  "15": ["03"], // Punjab
  "16": ["03", "04"], // Punjab + Chandigarh (160xxx)
  "17": ["02"], // Himachal Pradesh
  "18": ["01"], // Jammu & Kashmir
  "19": ["01", "38"], // J&K + Ladakh (Leh/Kargil 194xxx)
  "20": ["09"], // Uttar Pradesh
  "21": ["09"],
  "22": ["09"],
  "23": ["09"],
  "24": ["09", "05"], // UP + Uttarakhand (Kashipur 2447xx, Pauri 246xxx)
  "25": ["09"],
  "26": ["09", "05"], // UP + Uttarakhand (Nainital 263xxx beside Sitapur 261xxx)
  "27": ["09"],
  "28": ["09"],
  "30": ["08"], // Rajasthan
  "31": ["08"],
  "32": ["08"],
  "33": ["08"],
  "34": ["08"],
  "36": ["24", "26"], // Gujarat + Diu (3625xx)
  "37": ["24"],
  "38": ["24"],
  "39": ["24", "26"], // Gujarat + Daman/Silvassa (396xxx)
  "40": ["27", "30"], // Maharashtra + Goa (403xxx)
  "41": ["27"],
  "42": ["27"],
  "43": ["27"],
  "44": ["27"],
  "45": ["23"], // Madhya Pradesh
  "46": ["23"],
  "47": ["23"],
  "48": ["23"],
  "49": ["22"], // Chhattisgarh
  "50": ["36"], // Telangana
  "51": ["37"], // Andhra Pradesh
  "52": ["37"],
  "53": ["37", "34"], // AP + Yanam (Puducherry, 533464)
  "56": ["29"], // Karnataka
  "57": ["29"],
  "58": ["29"],
  "59": ["29"],
  "60": ["33", "34"], // Tamil Nadu + Puducherry/Karaikal (605xxx, 609xxx)
  "61": ["33"],
  "62": ["33"],
  "63": ["33"],
  "64": ["33"],
  "67": ["32", "34"], // Kerala + Mahe (Puducherry, 6733xx)
  "68": ["32", "31"], // Kerala + Lakshadweep (682xxx)
  "69": ["32"],
  "70": ["19"], // West Bengal
  "71": ["19"],
  "72": ["19"],
  "73": ["19", "11"], // WB + Sikkim (737xxx)
  "74": ["19", "35"], // WB + Andaman & Nicobar (744xxx)
  "75": ["21"], // Odisha
  "76": ["21"],
  "77": ["21"],
  "78": ["18"], // Assam
  "79": ["12", "13", "14", "15", "16", "17"], // the six other NE states
  "80": ["10"], // Bihar
  "81": ["10", "20"], // Bihar + Jharkhand (bifurcation interleaving)
  "82": ["10", "20"],
  "83": ["10", "20"],
  "84": ["10"],
  "85": ["10"],
};

/** [] = unknown prefix → do NOT refuse (log only). Invalid shape refused first. */
export function statesForPincode(pincode: string): readonly string[] {
  if (typeof pincode !== "string" || !PINCODE_RE.test(pincode)) {
    throw new AppError({
      code: "invalid_payload",
      message: `Malformed pincode ${JSON.stringify(pincode)}`,
      status: 422,
      publicMessage: "Enter a valid 6-digit pincode.",
      details: { issues: [{ path: "pincode", message: "Enter a valid 6-digit pincode." }] },
    });
  }
  return PINCODE_PREFIX_STATES[pincode.slice(0, 2)] ?? [];
}

/**
 * store_settings 'shipping.pincode_policy' (design D13 — no
 * shipping_zones table in Phase 2). Default when unset: {mode:"all"} —
 * checkout works day one. 'carrier' consults the existing
 * serviceability_cache via the carrier registry, cache-first.
 */
export type PincodePolicy =
  | { mode: "all" }
  | { mode: "carrier" }
  | { mode: "list"; allowedPrefixes: string[] };

/** store_settings keys — defined once so reader and writer cannot drift. */
export const SHIPPING_SETTINGS_KEYS = {
  pincodePolicy: "shipping.pincode_policy",
  flatFeePaise: "shipping.flat_fee_paise",
  freeAbovePaise: "shipping.free_above_paise",
} as const;

/**
 * The §1.10 shipping-fee rule as a pure function: flat fee, waived at or
 * above the free-shipping threshold. `freeAbovePaise` null = no
 * threshold. Integers in, integer out — money is BIGINT paise.
 */
export function computeShippingFeePaise(
  subtotalPaise: number,
  opts: { flatFeePaise: number; freeAbovePaise: number | null },
): number {
  for (const [path, value] of [
    ["subtotalPaise", subtotalPaise],
    ["flatFeePaise", opts.flatFeePaise],
    ...(opts.freeAbovePaise === null ? [] : [["freeAbovePaise", opts.freeAbovePaise] as const]),
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new AppError({
        code: "invalid_payload",
        message: `${path} must be a non-negative integer amount in paise`,
        status: 422,
        publicMessage: "Invalid amount.",
        details: { issues: [{ path, message: "Must be a non-negative integer in paise." }] },
      });
    }
  }
  if (opts.freeAbovePaise !== null && subtotalPaise >= opts.freeAbovePaise) return 0;
  return opts.flatFeePaise;
}
