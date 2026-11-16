import { nextJobPoNumber } from "@/lib/job-po-number";

// The purchase order a quote becomes when it is converted to a job (Justin,
// 31 Oct 2026: "Quote total, split by cost centre"): the job's next
// `<job number>-n` (so `-1` on a new job), valued at the quote's subtotal ex
// GST, unsplit — the office splits it across cost centres on the PO tab.
// Nothing to create for a $0 (or unreadable) quote.
//
// Shared by the web Convert to Job (components/quote/quote-detail.tsx) and the
// phone's conversion, which reaches the server through the
// /api/jobs/[id]/quote-po side effect (the phone can't know the job number
// until its queued job insert has synced).
export interface QuoteBudgetPo {
  po_number: string;
  total_value: number;
  total_hours: number;
}

export function quoteBudgetPo(
  jobNumber: number | string,
  existingPoNumbers: string[],
  quoteSubtotal: unknown
): QuoteBudgetPo | null {
  const value = Math.round((Number(quoteSubtotal) || 0) * 100) / 100;
  if (!(value > 0)) return null;
  return { po_number: nextJobPoNumber(jobNumber, existingPoNumbers), total_value: value, total_hours: 0 };
}
