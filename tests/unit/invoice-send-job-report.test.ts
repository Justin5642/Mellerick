import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// The optional job report on POST /api/invoices/[id]/send. What matters:
//   * callers that send no `jobReport` (the phone) get the old email, one PDF;
//   * a report that was asked for and could not be made sends NOTHING — the
//     customer must not silently get the invoice alone;
//   * the report goes as a second attachment.
// GET /job-report and POST /job-report/preview: office/admin guard first.

const requireOfficeOrAdmin = vi.fn((..._a: unknown[]) => undefined as unknown);
const callerClient = vi.fn((..._a: unknown[]) => undefined as unknown);
const renderDocumentPdf = vi.fn(async (..._a: unknown[]) => Buffer.from("invoice-pdf"));
const emailSend = vi.fn(async (..._a: unknown[]) => ({ error: null }));
const loadJobReportContext = vi.fn(async (..._a: unknown[]) => ({ ok: true, context: { invoice: { invoice_number: 42 } } }) as unknown);
const buildJobReportPdf = vi.fn(async (..._a: unknown[]) => ({ buffer: Buffer.from("report-pdf"), notice: null, photoCount: 2 }) as unknown);
const buildJobReportDraft = vi.fn(async (..._a: unknown[]) => ({}));

vi.mock("@/lib/api/guards", () => ({ requireOfficeOrAdmin: (...a: unknown[]) => requireOfficeOrAdmin(...a) }));
vi.mock("@/lib/api/caller-client", () => ({ callerClient: (...a: unknown[]) => callerClient(...a) }));
vi.mock("@/lib/pdf/render", () => ({ renderDocumentPdf: (...a: unknown[]) => renderDocumentPdf(...a) }));
vi.mock("@/lib/resend", () => ({ getResend: () => ({ emails: { send: emailSend } }), getFromAddress: () => "billing@test" }));
vi.mock("@/lib/business-info", () => ({ businessInfo: { name: "Test Co" } }));
vi.mock("@/lib/job-report-data", () => ({
  loadJobReportContext: (...a: unknown[]) => loadJobReportContext(...a),
  buildJobReportPdf: (...a: unknown[]) => buildJobReportPdf(...a),
  buildJobReportDraft: (...a: unknown[]) => buildJobReportDraft(...a),
}));

import { POST as invoiceSend } from "@/app/api/invoices/[id]/send/route";
import { GET as reportGet } from "@/app/api/invoices/[id]/job-report/route";
import { POST as reportPreview } from "@/app/api/invoices/[id]/job-report/preview/route";

const NextResponse = (await import("next/server")).NextResponse;

const INVOICE = {
  invoice_number: 42,
  title: "T",
  job_id: "job-1",
  customers: { name: "C", email: "c@test" },
  invoice_items: [{ id: 1 }],
  subtotal: 10,
  tax_amount: 1,
  total: 11,
  created_at: "2026-01-01",
  due_date: null,
  notes: null,
};

function mockClient(row: Record<string, unknown>) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "update"]) chain[m] = vi.fn(() => chain);
  chain.single = vi.fn(async () => ({ data: row, error: null }));
  chain.then = (r: (v: { error: null }) => unknown) => r({ error: null });
  return { from: vi.fn(() => chain) };
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (body: unknown) =>
  new NextRequest("https://app.test/api/x", { method: "POST", headers: { authorization: "Bearer t" }, body: JSON.stringify(body) });
const attachments = () => (emailSend.mock.calls[0][0] as { attachments: { filename: string }[] }).attachments.map((a) => a.filename);
const html = () => (emailSend.mock.calls[0][0] as { html: string }).html;

beforeEach(() => {
  vi.clearAllMocks();
  requireOfficeOrAdmin.mockResolvedValue({ ok: true, userId: "u1", role: "office" });
});

describe("invoice send — job report", () => {
  it("without jobReport (the phone's send) emails the invoice alone, as before", async () => {
    callerClient.mockResolvedValue(mockClient(INVOICE));
    const res = await invoiceSend(post({}), params("i1"));
    expect(res.status).toBe(200);
    expect(loadJobReportContext).not.toHaveBeenCalled();
    expect(attachments()).toEqual(["invoice-42.pdf"]);
    expect(html()).not.toContain("job report");
  });

  it("attaches the report as a second PDF and says so in the email", async () => {
    callerClient.mockResolvedValue(mockClient(INVOICE));
    const res = await invoiceSend(post({ jobReport: { notes: "Did it", photoIds: ["p1"], includeSignature: true } }), params("i1"));
    expect(res.status).toBe(200);
    expect(attachments()).toEqual(["invoice-42.pdf", "job-report-42.pdf"]);
    expect(html()).toContain("job report");
    expect(buildJobReportPdf.mock.calls[0][2]).toEqual({ notes: "Did it", photoIds: ["p1"], includeSignature: true });
    expect((await res.json()).jobReportAttached).toBe(true);
  });

  it("sends nothing when the report fails to render", async () => {
    callerClient.mockResolvedValue(mockClient(INVOICE));
    buildJobReportPdf.mockRejectedValueOnce(new Error("render blew up"));
    const res = await invoiceSend(post({ jobReport: { notes: "", photoIds: [] } }), params("i1"));
    expect(res.status).toBe(500);
    expect(emailSend).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.error).toContain("NOT sent");
    expect(body.error).not.toContain("blew up");
  });

  it("refuses a report for an invoice with no job, without sending", async () => {
    callerClient.mockResolvedValue(mockClient({ ...INVOICE, job_id: null }));
    const res = await invoiceSend(post({ jobReport: { notes: "", photoIds: [] } }), params("i1"));
    expect(res.status).toBe(400);
    expect(emailSend).not.toHaveBeenCalled();
  });

  it("refuses over-long notes, without sending", async () => {
    callerClient.mockResolvedValue(mockClient(INVOICE));
    const res = await invoiceSend(post({ jobReport: { notes: "x".repeat(20_001), photoIds: [] } }), params("i1"));
    expect(res.status).toBe(400);
    expect(emailSend).not.toHaveBeenCalled();
  });
});

describe("job report routes — authorization", () => {
  const routes = [
    { name: "GET job-report", run: () => reportGet(new NextRequest("https://app.test/api/x"), params("i1")) },
    { name: "POST preview", run: () => reportPreview(post({ notes: "", photoIds: [] }), params("i1")) },
  ];
  for (const r of routes) {
    it(`${r.name}: a technician is refused before any read`, async () => {
      requireOfficeOrAdmin.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "Insufficient permissions" }, { status: 403 }) });
      const res = await r.run();
      expect(res.status).toBe(403);
      expect(callerClient).not.toHaveBeenCalled();
      expect(loadJobReportContext).not.toHaveBeenCalled();
    });
  }

  it("GET passes the loader's fixed sentence through for an invoice with no job", async () => {
    callerClient.mockResolvedValue({});
    loadJobReportContext.mockResolvedValueOnce({ ok: false, status: 400, error: "This invoice is not linked to a job, so there is no job report." });
    const res = await reportGet(new NextRequest("https://app.test/api/x"), params("i1"));
    expect(res.status).toBe(400);
    expect(buildJobReportDraft).not.toHaveBeenCalled();
  });

  it("preview returns a PDF", async () => {
    callerClient.mockResolvedValue({});
    const res = await reportPreview(post({ notes: "x", photoIds: [], includeSignature: false }), params("i1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
  });
});
