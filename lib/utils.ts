import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Displayed invoice number, e.g. INV-27337 -- matches the numbering Xero
// itself already uses (its own long-running plain-numeric sequence, which
// our invoice_number column was bumped to continue from -- see migration
// 0019_bump_invoice_number_sequence.sql). Zero-padded to 4 digits as a
// floor so it still looks presentable if the sequence is ever small again.
export function formatInvoiceNumber(invoiceNumber: number | string) {
  return `INV-${String(invoiceNumber).padStart(4, "0")}`
}
