// Invoice/quote number display — mirrors the web lib/utils.formatInvoiceNumber
// (zero-padded to 4 digits; the raw value may be a Xero-assigned string after a
// push, which padStart passes through unchanged).
export function formatInvoiceNumber(n: number | string | null | undefined): string {
  return `INV-${String(n ?? "").padStart(4, "0")}`;
}
export function formatQuoteNumber(n: number | string | null | undefined): string {
  return `QUO-${String(n ?? "").padStart(4, "0")}`;
}
