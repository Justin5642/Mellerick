// Decide whether a job already has an invoice, from the guard query's result.
//
// THE BUG THIS REPLACES. app/dashboard/approvals/page.tsx read:
//
//     const { data: existingInvoice } = await supabase
//       .from("invoices").select("id, xero_invoice_id")
//       .eq("job_id", jobId).maybeSingle();
//     let invoiceId = existingInvoice?.id ?? null;
//
// The error was discarded, so a FAILED lookup was indistinguishable from "no
// invoice exists" — and the approval then created one. A network blip, an RLS
// change or an expired token therefore produced a DUPLICATE INVOICE to a real
// customer, silently.
//
// Worse in the case that matters most: `.maybeSingle()` RAISES when the query
// matches more than one row. So a job that already had two invoices — exactly
// the state you most want the guard to catch — made the guard error, and the
// discarded error made it create a third.
//
// A duplicate invoice is not a UI glitch. It reaches a customer, it reaches
// Xero, and someone has to credit it.

// PROGRESS CLAIMS (audit, 15 Nov 2026). A claim-billed job legitimately has
// several invoices — Claim 1, Claim 2, … — so "more than one invoice" is not a
// duplicate there. The guard used to read the job's invoices with
// .maybeSingle(), so a job with two claims was refused forever ("Resolve the
// duplicates") once 0098 sent it back to Approvals, and its unbilled hours
// could never be carried. The guard now reads the LIST and only refuses when
// more than one ORDINARY invoice exists. With claims and no ordinary invoice,
// the latest claim is the job's invoice: approval never builds a fresh invoice
// from the job's items, which the claims have already billed.

export interface InvoiceGuardRow {
  id: string;
  xero_invoice_id?: string | null;
  is_progress_claim?: boolean | null;
  claim_number?: number | null;
}

export interface InvoiceGuardResult {
  data: InvoiceGuardRow[] | null;
  error: { message: string; code?: string } | null;
}

export type InvoiceGuardVerdict =
  | { proceed: true; invoiceId: string | null; alreadyPushed: boolean; progressClaim: boolean }
  | { proceed: false; reason: string };

/** The guard query. Kept here so the route and the tests agree on the columns. */
export const INVOICE_GUARD_COLUMNS = "id, xero_invoice_id, is_progress_claim, claim_number" as const;

/**
 * FAILS CLOSED. When the guard cannot establish whether an invoice exists, the
 * approval stops rather than guessing — because the two ways to be wrong are not
 * symmetric. Refusing to approve is an inconvenience someone retries; inventing
 * a second invoice bills a customer twice.
 */
export function resolveExistingInvoice(result: InvoiceGuardResult): InvoiceGuardVerdict {
  if (result.error) {
    return {
      proceed: false,
      reason: `Could not check for an existing invoice (${result.error.message}). Approval stopped so a duplicate is not created.`,
    };
  }

  const rows = result.data ?? [];
  const ordinary = rows.filter((r) => !r.is_progress_claim);
  if (ordinary.length > 1) {
    return {
      proceed: false,
      reason: "This job already has more than one invoice. Resolve the duplicates before approving.",
    };
  }

  const chosen =
    ordinary[0] ??
    [...rows].sort((a, b) => Number(b.claim_number ?? 0) - Number(a.claim_number ?? 0))[0] ??
    null;

  return {
    proceed: true,
    invoiceId: chosen?.id ?? null,
    alreadyPushed: !!chosen?.xero_invoice_id,
    progressClaim: !!chosen?.is_progress_claim,
  };
}
