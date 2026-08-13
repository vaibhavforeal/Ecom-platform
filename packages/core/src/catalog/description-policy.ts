/**
 * The description-markup policy, as pure data. Lives apart from the
 * sanitiser so client components (the console's editor toolbar) can
 * import the ALLOWED lists without dragging sanitize-html — and its
 * fs-reading postcss dependency — into a client bundle.
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
