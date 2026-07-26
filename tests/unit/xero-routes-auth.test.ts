import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// Authorization contract for the Xero push routes after the Bearer refactor:
// push-invoice is ADMIN-only, push-expense is OFFICE/ADMIN-only. Each must reject
// via the shared guard BEFORE touching the DB or Xero — closing the prior gap
// where push-expense had no role check at all (any logged-in user could push).

const requireAdmin = vi.fn((..._a: unknown[]) => undefined as unknown);
const requireOfficeOrAdmin = vi.fn((..._a: unknown[]) => undefined as unknown);
const callerClient = vi.fn((..._a: unknown[]) => undefined as unknown);
const getRefreshedXero = vi.fn(async (..._a: unknown[]) => ({ xero: {}, tenantId: "t", defaultExpenseAccountCode: "200" }));

vi.mock("@/lib/api/guards", () => ({
  requireAdmin: (...a: unknown[]) => requireAdmin(...a),
  requireOfficeOrAdmin: (...a: unknown[]) => requireOfficeOrAdmin(...a),
}));
vi.mock("@/lib/api/caller-client", () => ({ callerClient: (...a: unknown[]) => callerClient(...a) }));
vi.mock("@/lib/xero", () => ({
  getRefreshedXero: (...a: unknown[]) => getRefreshedXero(...a),
  describeXeroError: (e: unknown) => String(e),
}));

import { POST as pushInvoice } from "@/app/api/xero/push-invoice/route";
import { POST as pushExpense } from "@/app/api/xero/push-expense/route";

const req = () => new NextRequest("https://app.test/api/xero/x", { method: "POST", body: "{}" });

beforeEach(() => vi.clearAllMocks());

describe("Xero push routes — authorization", () => {
  it("push-invoice: unauthenticated → 401, no DB/Xero", async () => {
    requireAdmin.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "x" }, { status: 401 }) });
    const res = await pushInvoice(req());
    expect(res.status).toBe(401);
    expect(callerClient).not.toHaveBeenCalled();
    expect(getRefreshedXero).not.toHaveBeenCalled();
  });

  it("push-invoice: non-admin (office) → 403 via requireAdmin", async () => {
    requireAdmin.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "x" }, { status: 403 }) });
    const res = await pushInvoice(req());
    expect(res.status).toBe(403);
    expect(callerClient).not.toHaveBeenCalled();
  });

  it("push-expense: technician/unauth → guard response, no DB/Xero (closes the prior no-role-check gap)", async () => {
    requireOfficeOrAdmin.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "x" }, { status: 403 }) });
    const res = await pushExpense(req());
    expect(res.status).toBe(403);
    expect(callerClient).not.toHaveBeenCalled();
    expect(getRefreshedXero).not.toHaveBeenCalled();
  });

  it("push-expense uses requireOfficeOrAdmin (not requireAdmin)", async () => {
    requireOfficeOrAdmin.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "x" }, { status: 403 }) });
    await pushExpense(req());
    expect(requireOfficeOrAdmin).toHaveBeenCalledTimes(1);
    expect(requireAdmin).not.toHaveBeenCalled();
  });
});
