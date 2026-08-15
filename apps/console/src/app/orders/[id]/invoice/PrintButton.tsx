"use client";

/** Spec §8: a visible "Print / Save as PDF" button — window.print() IS the PDF export. */
export function PrintButton() {
  return (
    <button type="button" onClick={() => window.print()}>
      Print / Save as PDF
    </button>
  );
}
