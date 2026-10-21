// Progress claims (migration 0084): the breakdown printed under a claim's line
// items — contract, claimed before, this claim, claimed to date, balance —
// all ex GST, as the contract value is (Simpro job values are ex GST).

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
