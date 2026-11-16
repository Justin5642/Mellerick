import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { quoteBudgetPo } from "@/lib/quote-job-po";

// A converted quote's subtotal becomes the job's `<job number>-1` PO — on the
// web directly, from the phone through /api/jobs/[id]/quote-po (the phone
// can't know the job number until its queued insert has synced).

describe("quoteBudgetPo", () => {
  it("is the job's first PO, valued at the quote subtotal ex GST, unsplit", () => {
    expect(quoteBudgetPo(4321, [], "1234.5")).toEqual({ po_number: "4321-1", total_value: 1234.5, total_hours: 0 });
  });
  it("takes the next number when the job already has one", () => {
    expect(quoteBudgetPo(4321, ["4321-1", "SIMPRO-9"], 10)?.po_number).toBe("4321-2");
  });
  it("makes nothing for a $0 or unreadable quote", () => {
    expect(quoteBudgetPo(1, [], 0)).toBeNull();
    expect(quoteBudgetPo(1, [], null)).toBeNull();
    expect(quoteBudgetPo(1, [], "abc")).toBeNull();
    expect(quoteBudgetPo(1, [], -5)).toBeNull();
  });
});

// ---- the route ----

const requireOfficeOrAdmin = vi.fn();
const inserts: Record<string, unknown>[] = [];
let existingPo: Record<string, unknown> | null = null;
let quote: Record<string, unknown> | null = null;
let job: Record<string, unknown> | null = null;
let jobPos: { po_number: string }[] = [];
let insertError: { code: string; message: string } | null = null;

vi.mock("@/lib/api/guards", () => ({ requireOfficeOrAdmin: (...a: unknown[]) => requireOfficeOrAdmin(...a) }));
vi.mock("@/lib/monitoring", () => ({ reportError: vi.fn() }));
const adminUsed = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => adminUsed() }));
vi.mock("@/lib/api/caller-client", () => ({
  callerClient: vi.fn(async () => ({
    from: (table: string) => {
      const filters: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = (col: string, v: unknown) => {
        filters[col] = v;
        return chain;
      };
      chain.maybeSingle = async () => ({
        data: table === "purchase_orders" ? existingPo : table === "quotes" ? quote : job,
        error: null,
      });
      chain.then = (r: (v: unknown) => unknown) => r({ data: table === "purchase_orders" && filters.job_id ? jobPos : [], error: null });
      chain.insert = async (row: Record<string, unknown>) => {
        if (insertError) return { error: insertError };
        inserts.push(row);
        return { error: null };
      };
      return chain;
    },
  })),
}));

import { POST } from "@/app/api/jobs/[id]/quote-po/route";

const JOB = "11111111-1111-4111-8111-111111111111";
const QUOTE = "22222222-2222-4222-8222-222222222222";
const PO = "33333333-3333-4333-8333-333333333333";
const call = (body: unknown = { quoteId: QUOTE, poId: PO }, jobId = JOB) =>
  POST(new NextRequest("http://localhost/x", { method: "POST", body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: jobId }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  inserts.length = 0;
  existingPo = null;
  quote = { id: QUOTE, job_id: JOB, subtotal: "5000.00" };
  job = { id: JOB, job_number: 901 };
  jobPos = [];
  insertError = null;
  requireOfficeOrAdmin.mockResolvedValue({ ok: true, userId: "office-1", role: "office" });
});

describe("POST /api/jobs/[id]/quote-po", () => {
  it("refuses anyone but office/admin (a PO carries money)", async () => {
    requireOfficeOrAdmin.mockResolvedValue({ ok: false, response: new Response("{}", { status: 403 }) });
    expect((await call()).status).toBe(403);
    expect(inserts).toHaveLength(0);
  });

  it("creates <job number>-1 at the quote's subtotal, with the phone's id, as the caller", async () => {
    const res = await call();
    expect(await res.json()).toEqual({ poNumber: "901-1" });
    expect(inserts).toEqual([{ id: PO, job_id: JOB, po_number: "901-1", total_value: 5000, total_hours: 0 }]);
    expect(adminUsed).not.toHaveBeenCalled();
  });

  it("ignores a value sent in the request — it reads the quote", async () => {
    await call({ quoteId: QUOTE, poId: PO, total_value: 1 });
    expect(inserts[0].total_value).toBe(5000);
  });

  it("numbers after POs the job already has", async () => {
    jobPos = [{ po_number: "901-1" }];
    expect(await (await call()).json()).toEqual({ poNumber: "901-2" });
  });

  it("a retry finds the PO it already made and adds nothing", async () => {
    existingPo = { id: PO, po_number: "901-1" };
    expect(await (await call()).json()).toEqual({ poNumber: "901-1" });
    expect(inserts).toHaveLength(0);
  });

  it("a racing duplicate on the primary key counts as done", async () => {
    insertError = { code: "23505", message: 'duplicate key value violates unique constraint "purchase_orders_pkey"' };
    expect((await call()).status).toBe(200);
  });

  it("makes nothing for a $0 quote", async () => {
    quote = { id: QUOTE, job_id: JOB, subtotal: 0 };
    expect(await (await call()).json()).toEqual({ poNumber: null });
    expect(inserts).toHaveLength(0);
  });

  it("refuses a quote not linked to this job, without a 404", async () => {
    quote = { id: QUOTE, job_id: "44444444-4444-4444-8444-444444444444", subtotal: 100 };
    expect((await call()).status).toBe(400);
    quote = null;
    expect((await call()).status).toBe(400);
    expect(inserts).toHaveLength(0);
  });

  it("refuses bad ids", async () => {
    expect((await call({ quoteId: "x", poId: PO })).status).toBe(400);
    expect((await call({ quoteId: QUOTE, poId: PO }, "nope")).status).toBe(400);
  });

  it("answers a database failure with a fixed sentence (retried by the outbox)", async () => {
    insertError = { code: "XX000", message: "relation internals" };
    const res = await call();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("internals");
  });
});
