"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { MAX_IMPORT_BYTES } from "@platform/core/catalog";
import type { CsvIssue, ImportProductResult, ImportReport } from "@platform/core/catalog";

/**
 * Upload, preview, confirm.
 *
 * Two round trips on purpose. The first is a dry run — the server does
 * every write inside a transaction it then throws away, so what comes
 * back is a report of writes that really succeeded rather than of writes
 * we believe would. Only then does the Apply button appear, and only if
 * the file had nothing wrong with it.
 *
 * Nothing here is a security boundary. The route re-checks the session,
 * the permission and every cell; this is about not making a merchant
 * wait for a round trip to learn they picked a 60 MB file.
 */

type Phase = "idle" | "working" | "previewed" | "committed";

export function ImportPanel() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(commit: boolean): Promise<void> {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError("Choose a CSV file first.");
      return;
    }
    if (file.size > MAX_IMPORT_BYTES) {
      setError(`That file is ${file.size} bytes. The limit is ${MAX_IMPORT_BYTES}.`);
      return;
    }

    setPhase("working");
    setError(null);

    try {
      const response = await fetch(`/api/products/import${commit ? "?commit=true" : ""}`, {
        method: "POST",
        headers: { "content-type": "text/csv" },
        body: file,
      });

      const body = (await response.json()) as {
        report?: ImportReport;
        error?: { message?: string };
      };

      if (!body.report) {
        setError(body.error?.message ?? "That upload could not be read.");
        setPhase("idle");
        return;
      }

      setReport(body.report);
      setPhase(body.report.committed ? "committed" : "previewed");
      // The product list is a server component; without this it would
      // still show the pre-import catalog when the merchant navigates
      // back to it.
      if (body.report.committed) router.refresh();
    } catch {
      setError("The upload did not finish. Check your connection and try again.");
      setPhase("idle");
    }
  }

  const clean = report !== null && report.issues.length === 0;

  return (
    <div className="panel">
      <h2>Import</h2>

      <div className="row">
        <div style={{ flex: 1 }}>
          <label htmlFor="csv">Catalog CSV</label>
          <input
            id="csv"
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            onChange={() => {
              setReport(null);
              setPhase("idle");
              setError(null);
            }}
          />
        </div>
        <button type="button" onClick={() => void send(false)} disabled={phase === "working"}>
          {phase === "working" ? "Checking…" : "Preview"}
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {report && (
        <>
          <Summary report={report} />
          {report.issues.length > 0 && <Issues issues={report.issues} />}
          {report.results.length > 0 && <Results results={report.results} />}

          {phase === "previewed" && clean && (
            <p style={{ marginTop: 16 }}>
              <button type="button" onClick={() => void send(true)}>
                Apply these changes
              </button>{" "}
              <span className="muted">Nothing has been saved yet.</span>
            </p>
          )}

          {phase === "committed" && (
            <p style={{ marginTop: 16 }} className="muted">
              Saved. <a href="/products">Back to products</a>
            </p>
          )}
        </>
      )}
    </div>
  );
}

function Summary({ report }: { report: ImportReport }) {
  return (
    <p style={{ marginTop: 16 }}>
      <strong>{report.committed ? "Imported" : "Dry run"}</strong> · {report.rows} rows ·{" "}
      {report.created} to create · {report.updated} to update · {report.skipped} already
      up to date
      {report.errored > 0 && (
        <>
          {" "}
          · <span className="error">{report.errored} rows with problems</span>
        </>
      )}
    </p>
  );
}

function Issues({ issues }: { issues: CsvIssue[] }) {
  return (
    <>
      <p className="error">
        Nothing was saved. Fix these in your spreadsheet and upload it again — the row
        numbers are the ones your spreadsheet shows.
      </p>
      <table className="grid">
        <thead>
          <tr>
            <th>Row</th>
            <th>Column</th>
            <th>Problem</th>
          </tr>
        </thead>
        <tbody>
          {issues.slice(0, 200).map((issue, i) => (
            <tr key={`${issue.row}-${issue.column}-${i}`}>
              <td>{issue.row}</td>
              <td>{issue.column ? <code>{issue.column}</code> : <span className="muted">—</span>}</td>
              <td>{issue.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {issues.length > 200 && (
        <p className="muted">…and {issues.length - 200} more. Fix these first.</p>
      )}
    </>
  );
}

function Results({ results }: { results: ImportProductResult[] }) {
  /**
   * A created product does not always get the URL its handle asked for.
   * A superseded slug still belongs to whichever product used to live
   * there — it is the redirect keeping that page's inbound links alive —
   * so a new product wanting it is given `handle-2` instead. Left
   * unsaid, the merchant re-imports the same file next week and gets
   * `handle-3`, and a third product they did not ask for.
   */
  const diverted = results.filter((r) => r.slug !== null && r.slug !== r.handle);

  return (
    <>
      {diverted.length > 0 && (
        <p className="error">
          {diverted.length === 1 ? "One product" : `${diverted.length} products`} could not take
          the web address in the handle column — another product used it first. Change the handle
          to the address shown, or the next import of this file will create another copy.
        </p>
      )}
      <table className="grid">
        <thead>
          <tr>
            <th>Row</th>
            <th>Handle</th>
            <th>Web address</th>
            <th>What happens</th>
            <th style={{ textAlign: "right" }}>Variants in file</th>
            <th style={{ textAlign: "right" }}>Variants kept</th>
          </tr>
        </thead>
        <tbody>
          {results.slice(0, 200).map((result) => (
            <tr key={result.handle}>
              <td>{result.row}</td>
              <td>
                <code>{result.handle}</code>
              </td>
              <td>
                {result.slug === result.handle ? (
                  <span className="muted">same</span>
                ) : (
                  <code className="error">/{result.slug}</code>
                )}
              </td>
              <td>
                <span
                  className={`badge badge-${result.outcome === "skipped" ? "archived" : "active"}`}
                >
                  {result.outcome}
                </span>
              </td>
              <td style={{ textAlign: "right" }}>{result.variantsWritten}</td>
              <td style={{ textAlign: "right" }}>
                {result.variantsRetained > 0 ? (
                  result.variantsRetained
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
