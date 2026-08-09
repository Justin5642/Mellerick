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

export interface InvoiceGuardRow {
  id: string;
  xero_invoice_id?: string | null;
}

export interface InvoiceGuardResult {
  data: InvoiceGuardRow | null;
  error: { message: string; code?: string } | null;
}

export type InvoiceGuardVerdict =
  | { proceed: true; invoiceId: string | null; alreadyPushed: boolean }
  | { proceed: false; reason: string };

/**
 * FAILS CLOSED. When the guard cannot establish whether an invoice exists, the
 * approval stops rather than guessing — because the two ways to be wrong are not
 * symmetric. Refusing to approve is an inconvenience someone retries; inventing
 * a second invoice bills a customer twice.
 */
export function resolveExistingInvoice(result: InvoiceGuardResult): InvoiceGuardVerdict {
  if (result.error) {
    // PGRST116 from .maybeSingle() means MULTIPLE rows matched — the job already
    // has more than one invoice. That is the strongest possible reason not to
    // create another, and it used to be the case that created one.
    const multiple = result.error.code === "PGRST116";
    return {
      proceed: false,
      reason: multiple
        ? "This job already has more than one invoice. Resolve the duplicates before approving."
        : `Could not check for an existing invoice (${result.error.message}). Approval stopped so a duplicate is not created.`,
    };
  }

  return {
    proceed: true,
    invoiceId: result.data?.id ?? null,
    alreadyPushed: !!result.data?.xero_invoice_id,
  };
}
