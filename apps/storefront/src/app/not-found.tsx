import Link from "next/link";

/**
 * The 404 page.
 *
 * Present as a real App Router route, not left to Next's fallback. The
 * fallback lives in the Pages Router and pulls in `<Html>`, which cannot
 * be prerendered from an App Router build — the build fails outright
 * with "Html should not be imported outside of pages/_document".
 *
 * Deliberately says nothing about which store this is. This page renders
 * for an unrecognised HOSTNAME as well as for a missing product, and at
 * that point there is no tenant to name — printing one would mean
 * picking a default tenant, which blueprint §2.3 forbids.
 */
export default function NotFound() {
  return (
    <main>
      <h1>Not found</h1>
      <p className="muted">
        That page does not exist, or the store is not available at this address.
      </p>
      <p>
        <Link href="/">Go to the home page</Link>
      </p>
    </main>
  );
}
