import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Authorization contract for the invoice/quote send + pdf routes after the
// Bearer refactor. Each must: reject an unauthenticated caller (401) and a
// wrong-role caller (403) via the shared guard BEFORE touching the DB / PDF /
// email, and — when office/admin — proceed through the caller-scoped client.

const requireOfficeOrAdmin = vi.fn((..._a: unknown[]) => undefined as unknown);
const callerClient = vi.fn((..._a: unknown[]) => undefined as unknown);
const renderDocumentPdf = vi.fn(async (..._a: unknown[]) => Buffer.from("pdf"));
const emailSend = vi.fn(async (..._a: unknown[]) => ({ error: null }));

vi.mock("@/lib/api/guards", () => ({ requireOfficeOrAdmin: (...a: unknown[]) => requireOfficeOrAdmin(...a) }));
vi.mock("@/lib/api/caller-client", () => ({ callerClient: (...a: unknown[]) => callerClient(...a) }));
vi.mock("@/lib/pdf/render", () => ({ renderDocumentPdf: (...a: unknown[]) => renderDocumentPdf(...a) }));
vi.mock("@/lib/resend", () => ({ getResend: () => ({ emails: { send: emailSend } }), getFromAddress: () => "billing@test" }));
vi.mock("@/lib/business-info", () => ({ businessInfo: { name: "Test Co" } }));

import { POST as invoiceSend } from "@/app/api/invoices/[id]/send/route";
import { GET as invoicePdf } from "@/app/api/invoices/[id]/pdf/route";
import { POST as quoteSend } from "@/app/api/quotes/[id]/send/route";
import { GET as quotePdf } from "@/app/api/quotes/[id]/pdf/route";

const NextResponse = (await import("next/server")).NextResponse;

function docChain(row: Record<string, unknown>) {
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "eq", "update"]) chain[m] = vi.fn(() => chain);
  chain.single = vi.fn(async () => ({ data: row, error: null }));
  chain.then = (r: (v: { error: null }) => unknown) => r({ error: null }); // for the status update
  return chain;
}
function mockClient(row: Record<string, unknown>) {
  return { from: vi.fn(() => docChain(row)) };
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new NextRequest("https://app.test/api/x", { method: "POST", headers: { authorization: "Bearer t" }, body: "{}" });
const getReq = () => new NextRequest("https://app.test/api/x", { headers: { authorization: "Bearer t" } });

const routes = [
  { name: "invoice send", run: () => invoiceSend(req(), params("i1")) },
  { name: "invoice pdf", run: () => invoicePdf(getReq(), params("i1")) },
  { name: "quote send", run: () => quoteSend(req(), params("q1")) },
  { name: "quote pdf", run: () => quotePdf(getReq(), params("q1")) },
];

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://unit-test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
});

describe("document routes — authorization", () => {
  for (const r of routes) {
    it(`${r.name}: unauthenticated → 401 and never touches the DB/PDF`, async () => {
      requireOfficeOrAdmin.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "Not authenticated" }, { status: 401 }) });
      const res = await r.run();
      expect(res.status).toBe(401);
      expect(callerClient).not.toHaveBeenCalled();
      expect(renderDocumentPdf).not.toHaveBeenCalled();
      expect(emailSend).not.toHaveBeenCalled();
    });

    it(`${r.name}: wrong role → 403 and never touches the DB/PDF`, async () => {
      requireOfficeOrAdmin.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "Insufficient permissions" }, { status: 403 }) });
      const res = await r.run();
      expect(res.status).toBe(403);
      expect(callerClient).not.toHaveBeenCalled();
    });
  }

  it("invoice pdf: office/admin caller proceeds via the caller-scoped client and renders", async () => {
    requireOfficeOrAdmin.mockResolvedValue({ ok: true, userId: "u1", role: "office" });
    callerClient.mockResolvedValue(
      mockClient({ invoice_number: 42, title: "T", customers: { name: "C" }, invoice_items: [{ id: 1 }], subtotal: 10, tax_amount: 1, total: 11, created_at: "2026-01-01", due_date: null, notes: null })
    );
    const res = await invoicePdf(getReq(), params("i1"));
    expect(callerClient).toHaveBeenCalledTimes(1);
    expect(renderDocumentPdf).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
  });
});
