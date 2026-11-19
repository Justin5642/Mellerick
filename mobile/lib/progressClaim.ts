// Mirror of lib/progress-claim.ts for the phone: the progress-claim breakdown and the New / Edit Invoice claim fields.
// Everything below the first blank line is byte-identical to the web file
// (pinned by tests/unit/invoice-phone-mirrors.test.ts) — change the web file
// first, then copy its body here.

export interface ProgressClaimFigures {
  claimNumber: number;
  contractValue: number;
  previous: number;
  /** This claim, ex GST: the invoice subtotal. */
  thisClaim: number;
}

export interface ProgressBreakdown extends ProgressClaimFigures {
  toDate: number;
  balance: number;
  pctPrevious: number;
  pctThis: number;
  pctToDate: number;
}

const cents = (n: number) => Math.round(n * 100) / 100;
/** One decimal place: 43.5. */
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

export function progressBreakdown(f: ProgressClaimFigures): ProgressBreakdown {
  const toDate = cents(f.previous + f.thisClaim);
  return {
    ...f,
    toDate,
    // Negative when a claim overshoots the contract — shown as such, so a
    // mistake is visible rather than quietly clamped to zero.
    balance: cents(f.contractValue - toDate),
    pctPrevious: pct(f.previous, f.contractValue),
    pctThis: pct(f.thisClaim, f.contractValue),
    pctToDate: pct(toDate, f.contractValue),
  };
}

/** The claim figures off an invoice row, or null when it is not a claim. */
export function invoiceProgress(invoice: {
  is_progress_claim?: boolean | null;
  claim_number?: number | null;
  claim_contract_value?: number | string | null;
  claim_previous?: number | string | null;
  subtotal: number | string;
}): ProgressBreakdown | null {
  if (!invoice.is_progress_claim || invoice.claim_number == null || invoice.claim_contract_value == null) return null;
  return progressBreakdown({
    claimNumber: invoice.claim_number,
    contractValue: Number(invoice.claim_contract_value),
    previous: Number(invoice.claim_previous ?? 0),
    thisClaim: Number(invoice.subtotal),
  });
}

/**
 * Defaults for the next claim on a job: carry on from its latest claim in the
 * app (whose previous already includes any Simpro-era amount typed in on the
 * first one); with none, claim 1 against the Simpro job value.
 */
export function nextClaimDefaults(
  latest: { claim_number: number | null; claim_contract_value: number | string | null; claim_previous: number | string | null; subtotal: number | string | null } | null,
  simproJobValue: number | null
): { claimNumber: number; contractValue: number | null; previous: number } {
  if (latest && latest.claim_number != null) {
    return {
      claimNumber: latest.claim_number + 1,
      contractValue: latest.claim_contract_value != null ? Number(latest.claim_contract_value) : simproJobValue,
      previous: cents(Number(latest.claim_previous ?? 0) + Number(latest.subtotal ?? 0)),
    };
  }
  return { claimNumber: 1, contractValue: simproJobValue && simproJobValue > 0 ? simproJobValue : null, previous: 0 };
}

// The New / Edit Invoice form's claim fields (web components/invoice/
// progress-claim-fields.tsx and the phone), as typed, and the invoice columns
// they save to.

export interface ClaimDraft {
  on: boolean;
  number: string;
  contract: string;
  previous: string;
}

export const emptyClaimDraft: ClaimDraft = { on: false, number: "", contract: "", previous: "" };

export function claimDraftFromInvoice(inv: {
  is_progress_claim?: boolean | null;
  claim_number?: number | null;
  claim_contract_value?: number | string | null;
  claim_previous?: number | string | null;
}): ClaimDraft {
  if (!inv.is_progress_claim) return emptyClaimDraft;
  return {
    on: true,
    number: inv.claim_number != null ? String(inv.claim_number) : "",
    contract: inv.claim_contract_value != null ? String(Number(inv.claim_contract_value)) : "",
    previous: inv.claim_previous != null ? String(Number(inv.claim_previous)) : "0",
  };
}

/** The invoice columns for a draft, or the reason it cannot be saved. */
export function claimColumns(d: ClaimDraft):
  | { ok: true; columns: { is_progress_claim: boolean; claim_number: number | null; claim_contract_value: number | null; claim_previous: number | null } }
  | { ok: false; error: string } {
  if (!d.on) return { ok: true, columns: { is_progress_claim: false, claim_number: null, claim_contract_value: null, claim_previous: null } };
  const number = parseInt(d.number, 10);
  const contract = parseFloat(d.contract);
  const previous = d.previous.trim() === "" ? 0 : parseFloat(d.previous);
  if (!Number.isInteger(number) || number < 1) return { ok: false, error: "Enter the progress claim number" };
  if (!(contract > 0)) return { ok: false, error: "Enter the contract value (ex GST) for the progress claim" };
  if (Number.isNaN(previous) || previous < 0) return { ok: false, error: "Previously claimed must be 0 or more" };
  return { ok: true, columns: { is_progress_claim: true, claim_number: number, claim_contract_value: contract, claim_previous: previous } };
}
