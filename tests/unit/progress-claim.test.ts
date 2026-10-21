import { describe, it, expect } from "vitest";
import { invoiceProgress, nextClaimDefaults, progressBreakdown } from "@/lib/progress-claim";
import { claimColumns } from "@/components/invoice/progress-claim-fields";
import { xeroReference } from "@/lib/job-site";

describe("progressBreakdown", () => {
  it("works out to date, balance and percentages (Sargood St, claim 2)", () => {
    expect(progressBreakdown({ claimNumber: 2, contractValue: 9200, previous: 3000, thisClaim: 4000 })).toMatchObject({
      toDate: 7000,
      balance: 2200,
      pctPrevious: 32.6,
      pctThis: 43.5,
      pctToDate: 76.1,
    });
  });
  it("shows an overshoot as a negative balance instead of hiding it", () => {
    expect(progressBreakdown({ claimNumber: 3, contractValue: 1000, previous: 900, thisClaim: 200 }).balance).toBe(-100);
  });
});

describe("invoiceProgress", () => {
  it("is null for an ordinary invoice", () => {
    expect(invoiceProgress({ is_progress_claim: false, subtotal: 100 })).toBeNull();
  });
  it("reads numeric strings from the database", () => {
    expect(invoiceProgress({ is_progress_claim: true, claim_number: 1, claim_contract_value: "500.00", claim_previous: "0.00", subtotal: "250.00" })?.pctToDate).toBe(50);
  });
});

describe("nextClaimDefaults", () => {
  it("carries on from the job's latest claim, including a Simpro-era amount", () => {
    expect(nextClaimDefaults({ claim_number: 2, claim_contract_value: 9200, claim_previous: 3000, subtotal: 4000 }, 9200)).toEqual({
      claimNumber: 3,
      contractValue: 9200,
      previous: 7000,
    });
  });
  it("starts at claim 1 against the Simpro job value", () => {
    expect(nextClaimDefaults(null, 9200)).toEqual({ claimNumber: 1, contractValue: 9200, previous: 0 });
    expect(nextClaimDefaults(null, null).contractValue).toBeNull();
  });
});

describe("claimColumns — what the 0084 check constraint accepts", () => {
  it("clears every claim column when not a claim", () => {
    expect(claimColumns({ on: false, number: "2", contract: "9200", previous: "1" })).toEqual({
      ok: true,
      columns: { is_progress_claim: false, claim_number: null, claim_contract_value: null, claim_previous: null },
    });
  });
  it("needs a claim number and a contract value", () => {
    expect(claimColumns({ on: true, number: "", contract: "9200", previous: "" }).ok).toBe(false);
    expect(claimColumns({ on: true, number: "2", contract: "", previous: "" }).ok).toBe(false);
  });
  it("treats a blank previously-claimed as 0", () => {
    expect(claimColumns({ on: true, number: "1", contract: "9200", previous: "" })).toEqual({
      ok: true,
      columns: { is_progress_claim: true, claim_number: 1, claim_contract_value: 9200, claim_previous: 0 },
    });
  });
});

it("puts the claim number in the Xero reference", () => {
  expect(xeroReference({ jobNumber: 524, lines: ["6 Sargood Street", "Toorak VIC 3142"] }, "MBO-1187", 2)).toBe(
    "PO MBO-1187 · Claim 2 · Job #524 · 6 Sargood Street, Toorak VIC 3142"
  );
});
