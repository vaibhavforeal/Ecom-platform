import sanitizeHtml from "sanitize-html";

/**
 * Merchant-authored rich text, made safe to put in the DOM.
 *
 * A product description is the one field on the storefront that a
 * merchant fills with markup and a shopper's browser then executes. In a
 * multi-tenant SaaS that is not "the merchant attacking themselves": the
 * script runs against THEIR customers, on a page that goes on to collect
 * addresses and card details. So this is stored XSS with a payment form
 * downstream of it, which is why the PDP rendered plain text until this
 * file existed.
 *
 * Three decisions, all deliberate:
 *
 *  1. **Allowlist, never a blocklist.** A blocklist is a list of the
 *     bypasses someone has already thought of. Anything not named below
 *     is discarded, so a tag or attribute nobody anticipated is refused
 *     by default rather than by omission.
 *
 *  2. **A real parser, not a regex.** HTML is not regular, and every
 *     hand-rolled regex sanitiser is a CVE with a wait time —
 *     `<scr<script>ipt>` and `<img src=x onerror=alert(1)//` are the two
 *     that get written up first. `sanitize-html` runs htmlparser2 and
 *     re-serialises from the parse tree, so what comes out is what the
 *     browser will actually see.
 *
 *  3. **Sanitise on WRITE.** The console calls this and stores the
 *     result. Sanitising on read means every future reader — CSV export,
 *     a WhatsApp preview, an AI description rewriter — has to remember,
 *     and the one that forgets is the breach.
 *
 * Pure — no database, no filesystem, no network — which is why it sits
 * in the client-safe `@platform/core/catalog` barrel rather than in
 * `/server`. One honest caveat: `sanitize-html` depends on `postcss`,
 * which reads `fs`, so this module is tree-shaken out of the storefront's
 * client bundle rather than being small enough to ship there. Nothing
 * needs it in the browser — sanitising happens once, on write — and a
 * client component that imported it would fail the build loudly, which
 * is the right failure.
 */

/**
 * What a merchant may write.
 *
 * Structure and emphasis, nothing else. Notably absent and deliberately
 * so: `img` and `video` (media belongs in the gallery, where it is
 * validated, resized and served from our own storage), `table` (a
 * pasted Word table is a layout bug on a phone), `span`/`div` and
 * `class` (a merchant restyling the page breaks the theme), and `h1`
 * (the PDP already has one — a second splits the document outline).
 */
export const ALLOWED_DESCRIPTION_TAGS = [
  "p",
  "br",
  "strong",
  "em",
  "u",
  "ul",
  "ol",
  "li",
  "h2",
  "h3",
  "h4",
  "a",
  "blockquote",
] as const;

/**
 * The only URL schemes a link may use.
 *
 * `javascript:` is script execution by another name. `data:` can carry
 * `text/html`, which is same-origin script execution one click away.
 * Everything else (`vbscript:`, `file:`, custom app schemes) has no
 * business in a product description.
 */
export const ALLOWED_LINK_SCHEMES = ["http:", "https:", "mailto:"] as const;

/** Forced onto every surviving link. See `linkAttributes`. */
const LINK_REL = "nofollow noopener";

/**
 * Is this href one a customer may safely be sent to?
 *
 * Parsed with `URL` rather than pattern-matched, so the padding tricks
 * that defeat string comparison — leading whitespace and control
 * characters, `JaVaScRiPt:`, `java\tscript:`, `%6Aavascript:` — are
 * resolved by the same code the browser uses before the scheme is read.
 *
 * A base is deliberately NOT supplied: without one, `URL` throws on
 * anything that is not absolute, which is exactly the answer wanted for
 * `//evil.com` (protocol-relative, and therefore attacker-controlled
 * once the page is served over https) and for bare relative paths. A
 * description is body copy, not navigation; the merchant who wants an
 * internal link can write the full URL.
 */
function safeHref(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  return (ALLOWED_LINK_SCHEMES as readonly string[]).includes(url.protocol) ? url.href : null;
}

/**
 * The attribute set for a link that survived `safeHref`.
 *
 * `rel="nofollow"` because a product description is user-generated
 * content and a merchant's SEO should not be sellable by whoever talks
 * them into a link. `noopener` because a `target="_blank"` link without
 * it hands the opened page a live `window.opener` reference to the
 * storefront — reverse tabnabbing, which is a phishing primitive on a
 * page that collects payment details.
 *
 * `target="_blank"` only for http(s). On a `mailto:` it asks the browser
 * to open a blank tab alongside the mail client, which some browsers
 * duly do and no one wants.
 */
function linkAttributes(href: string): Record<string, string> {
  const isWeb = href.startsWith("http:") || href.startsWith("https:");
  return {
    href,
    rel: LINK_REL,
    ...(isWeb ? { target: "_blank" } : {}),
  };
}

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [...ALLOWED_DESCRIPTION_TAGS],

  /**
   * `href`, `rel` and `target` on `a`, and nothing else, anywhere. No
   * `style` (CSS is an injection surface of its own), no `class`, no
   * `id`, and no `on*` handler survives a list this short.
   *
   * `rel` and `target` are listed only so the values FORCED by
   * `transformTags` are not filtered back off — sanitize-html runs the
   * transform first and applies this list afterwards. Whatever the
   * merchant wrote in either is already gone by then, because the
   * transform rebuilds the attribute set from scratch.
   */
  allowedAttributes: { a: ["href", "rel", "target"] },

  /**
   * The href check is done in `transformTags` above, by `safeHref`.
   * These two are the library's own, kept as a second gate: if a future
   * edit to the transform ever lets something through, the scheme filter
   * still refuses it.
   */
  allowedSchemes: ALLOWED_LINK_SCHEMES.map((s) => s.replace(":", "")),
  allowedSchemesAppliedToAttributes: ["href"],
  allowProtocolRelative: false,

  // Discard a disallowed tag rather than escaping it into visible
  // `&lt;script&gt;` text on the merchant's own page.
  disallowedTagsMode: "discard",

  /**
   * Tags whose TEXT is dropped along with the tag.
   *
   * Without this, `<script>alert(1)</script>` discards the tag and keeps
   * `alert(1)` as body copy — harmless, but it means every stripped
   * script leaves its source printed on the page. `style` matters more:
   * its contents are CSS, and CSS pasted as text is nonsense.
   */
  nonTextTags: ["script", "style", "textarea", "option", "noscript", "template"],

  transformTags: {
    /**
     * Rebuilt from scratch, not filtered.
     *
     * Returning a fresh `attribs` means anything the merchant put on the
     * anchor is gone by construction rather than by having been named in
     * a list — which is the same allowlist argument one level down.
     */
    a: (_tagName, attribs) => {
      const href = typeof attribs.href === "string" ? safeHref(attribs.href) : null;
      return {
        tagName: "a",
        // A link whose target was refused keeps its text and loses its
        // href. Dropping the whole element would silently delete a
        // sentence the merchant wrote; a dead-looking link is visible.
        attribs: href ? linkAttributes(href) : {},
      };
    },
  },
};

/**
 * Sanitises a merchant-authored product description.
 *
 * Returns `""` for empty or whitespace-only input so a caller can store
 * `null` rather than a string of markup that renders as nothing.
 */
export function sanitizeDescriptionHtml(input: string): string {
  if (input.trim() === "") return "";
  return sanitizeHtml(input, OPTIONS).trim();
}
