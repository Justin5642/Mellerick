import { describe, expect, it } from "vitest";
import { jobNumbersIn, matchInvoice, parseTarget, siteMentioned, type JobCandidate, type PoCandidate } from "@/lib/supplier-invoice-match";

const job = (n: number, extra: Partial<JobCandidate> = {}): JobCandidate => ({
  id: `job-${n}`, job_number: n, title: `Job ${n}`, status: "in_progress", customer_name: "Builder",
  address_line1: "12 Smith Street", suburb: "Penrith", ...extra,
});
const po = (n: number, extra: Partial<PoCandidate> = {}): PoCandidate => ({
  id: `po-${n}`, po_number: `PO-${n}`, job_id: "job-2542", vendor_name: "Reece", amount: 500,
  status: "ordered", invoice_number: null, xero_bill_id: null, ...extra,
});
const inv = (extra: Record<string, unknown> = {}) => ({
  doc_kind: "invoice", supplier_name: "Reece Pty Ltd", amount_ex_gst: 510, po_refs: [] as string[], job_refs: [] as string[], site_text: null as string | null, ...extra,
});

describe("matchInvoice", () => {
  const jobs = [job(2542), job(2600, { address_line1: "4 Jones Rd", suburb: "Penrith" })];

  it("puts an invoice quoting our PO on that PO", () => {
    const m = matchInvoice(inv({ po_refs: ["po 1008"] }), [po(1008)], jobs);
    expect(m.kind).toBe("po");
    if (m.kind === "po") {
      expect(m.po.po_number).toBe("PO-1008");
      expect(m.job?.job_number).toBe(2542);
      expect(m.blocked).toBeNull();
      expect(m.notes).toEqual([]);
    }
  });

  it("blocks a PO that already has an invoice, is in Xero, or was cancelled", () => {
    for (const [extra, says] of [
      [{ invoice_number: "INV-9" }, "already has invoice INV-9"],
      [{ xero_bill_id: "x" }, "already a bill in Xero"],
      [{ status: "cancelled" }, "was cancelled"],
    ] as const) {
      const m = matchInvoice(inv({ po_refs: ["PO-1008"] }), [po(1008, extra)], jobs);
      expect(m.kind === "po" && m.blocked).toContain(says);
    }
  });

  it("notes a big amount difference and a different supplier", () => {
    const m = matchInvoice(inv({ po_refs: ["PO-1008"], amount_ex_gst: 900, supplier_name: "Tradelink" }), [po(1008)], jobs);
    expect(m.kind === "po" && m.notes.join(" ")).toMatch(/raised for \$500\.00.*Tradelink/);
  });

  it("does not put a credit note on a PO", () => {
    const m = matchInvoice(inv({ doc_kind: "credit_note", po_refs: ["PO-1008"], job_refs: ["Job 2542"] }), [po(1008)], jobs);
    expect(m.kind).toBe("job");
  });

  it("falls back to a job number when the PO number is not ours", () => {
    const m = matchInvoice(inv({ po_refs: ["2542"] }), [po(1008)], jobs);
    expect(m).toMatchObject({ kind: "job", via: "job number", job: { job_number: 2542 } });
  });

  it("counts a bare number as our PO only when the supplier matches", () => {
    const pos = [po(2542, { vendor_name: "Tradelink" })];
    expect(matchInvoice(inv({ po_refs: ["2542"] }), pos, jobs)).toMatchObject({ kind: "job", job: { job_number: 2542 } });
    expect(matchInvoice(inv({ po_refs: ["2542"], supplier_name: "TRADELINK PTY LTD" }), pos, jobs).kind).toBe("po");
    expect(matchInvoice(inv({ po_refs: ["PO 2542"] }), pos, jobs).kind).toBe("po");
  });

  it("reads a builder PO as its job", () => {
    const m = matchInvoice(inv({ po_refs: ["2600-3"] }), [], jobs);
    expect(m).toMatchObject({ kind: "job", via: "builder PO", job: { job_number: 2600 } });
  });

  it("matches the site when exactly one open job is there", () => {
    const m = matchInvoice(inv({ site_text: "Deliver to: 4 JONES ROAD PENRITH NSW" }), [], jobs);
    expect(m).toMatchObject({ kind: "job", via: "site", job: { job_number: 2600 } });
  });

  it("does not guess between two open jobs at the same site", () => {
    const m = matchInvoice(inv({ site_text: "12 Smith St" }), [], [job(2542), job(2543)]);
    expect(m.kind).toBe("none");
    expect(m.notes[0]).toContain("#2542, #2543");
  });

  it("ignores closed jobs when matching by site, but still flags them by number", () => {
    const closed = [job(2542, { status: "completed" })];
    expect(matchInvoice(inv({ site_text: "12 Smith St" }), [], closed).kind).toBe("none");
    const m = matchInvoice(inv({ job_refs: ["#2542"] }), [], closed);
    expect(m.kind === "job" && m.notes[0]).toContain("completed");
  });

  it("leaves statements and other documents unmatched", () => {
    expect(matchInvoice(inv({ doc_kind: "statement", po_refs: ["PO-1008"] }), [po(1008)], jobs).kind).toBe("none");
  });
});

describe("helpers", () => {
  it("finds job numbers in refs", () => {
    expect(jobNumbersIn({ job_refs: ["Job 2542"], po_refs: ["JOHN SMITH", "2600/2", "J#2601"] }).map((j) => j.n)).toEqual([2542, 2600, 2601]);
  });

  it("needs the street number and name, not just the suburb", () => {
    expect(siteMentioned("PENRITH NSW 2750", "12 Smith Street")).toBe(false);
    expect(siteMentioned("Unit 3, 12 Smith St Penrith", "12 Smith Street")).toBe(true);
    expect(siteMentioned("120 Smith St", "12 Smith Street")).toBe(false);
  });

  it("parses what the office types", () => {
    expect(parseTarget("PO-1008")).toEqual({ po: "PO-1008", job: null });
    expect(parseTarget("1008")).toEqual({ po: "PO-1008", job: 1008 });
    expect(parseTarget("#2542")).toEqual({ po: "PO-2542", job: 2542 });
    expect(parseTarget("job 2542")).toEqual({ po: null, job: 2542 });
  });
});
