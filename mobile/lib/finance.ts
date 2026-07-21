// Invoice/quote number display — mirrors the web lib/utils.formatInvoiceNumber
// (zero-padded to 4 digits; the raw value may be a Xero-assigned string after a
// push, which padStart passes through unchanged).
export function formatInvoiceNumber(n: number | string | null | undefined): string {
  return `INV-${String(n ?? "").padStart(4, "0")}`;
}
// Web renders quotes as a bare "#7" everywhere (no prefix, no padding) — only
// invoices get the INV-0000 treatment. Match it so the identifier is consistent
// across web, mobile, the emailed quote, and the PDF.
export function formatQuoteNumber(n: number | string | null | undefined): string {
  return `#${n ?? ""}`;
}
