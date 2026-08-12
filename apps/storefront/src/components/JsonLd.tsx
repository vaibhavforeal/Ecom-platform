import type { JsonLd as JsonLdData } from "../lib/seo";

/**
 * Emits structured data.
 *
 * `JSON.stringify` output is escaped before it goes into the script tag.
 * The catalog is merchant-authored, so a product title containing
 * `</script>` would otherwise close the block early and put the rest of
 * the JSON into the document as markup — stored XSS through a product
 * name. Escaping `<` is enough to prevent it and stays valid JSON.
 */
export function JsonLd({ data }: { data: JsonLdData | JsonLdData[] }) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");

  return (
    <script
      type="application/ld+json"
      // The value is serialised by us from database rows, and escaped
      // above — never raw merchant HTML.
      dangerouslySetInnerHTML={{ __html: json }}
    />
  );
}
