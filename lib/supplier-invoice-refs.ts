// Pure helpers for supplier invoices (0103), safe to import in the browser —
// lib/supplier-invoice-read.ts carries the Anthropic SDK and stays server-side.

/**
 * Our supplier PO numbers in what an invoice printed. Ours are PO-1001
 * upwards (0085); suppliers print them as "PO-1008", "PO 1008", "po1008",
 * "#1008" or just "1008". A bare number counts only when it is in our range
 * shape (4+ digits) — matching then checks it actually exists.
 */
export function ourPoNumbers(orderRefs: string[]): string[] {
  const out = new Set<string>();
  for (const r of orderRefs) {
    const m = r.match(/\bP\.?\s*O\.?\s*[-#:]?\s*(\d{4,6})\b/i) ?? r.match(/^\s*#?\s*(\d{4,6})\s*$/);
    if (m) out.add(`PO-${Number(m[1])}`);
  }
  return [...out];
}

/** Supplier names compared loosely: "Reece Pty Ltd" = "REECE". */
export function supplierKey(name: string | null): string {
  return (name ?? "")
    .toLowerCase()
    .replace(/\b(pty|ltd|limited|p\/l|australia|aust|group|the|plumbing supplies)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
}
