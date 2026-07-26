import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// Authorization contract for the integration "Sync now" routes after the fix.
// Both were previously getUser()-only (any signed-in user — including a
// technician — could trigger a Xero/Google sync). They are now office/admin-only
// and must reject via the guard BEFORE running the sync.

const requireOfficeOrAdmin = vi.fn((..._a: unknown[]) => undefined as unknown);
const callerClient = vi.fn((..._a: unknown[]) => undefined as unknown);
const pollXeroInvoicePayments = vi.fn(async (..._a: unknown[]) => ({ synced: 0 }));
const pollGoogleCalendarChanges = vi.fn(async (..._a: unknown[]) => ({ synced: 0 }));

vi.mock("@/lib/api/guards", () => ({ requireOfficeOrAdmin: (...a: unknown[]) => requireOfficeOrAdmin(...a) }));
vi.mock("@/lib/api/caller-client", () => ({ callerClient: (...a: unknown[]) => callerClient(...a) }));
vi.mock("@/lib/xero", () => ({ pollXeroInvoicePayments: (...a: unknown[]) => pollXeroInvoicePayments(...a) }));
vi.mock("@/lib/google", () => ({ pollGoogleCalendarChanges: (...a: unknown[]) => pollGoogleCalendarChanges(...a) }));

import { POST as xeroSyncNow } from "@/app/api/xero/sync-now/route";
import { POST as googleSyncNow } from "@/app/api/google/sync-now/route";

const req = () => new NextRequest("https://app.test/api/x/sync-now", { method: "POST" });

beforeEach(() => vi.clearAllMocks());

const cases = [
  { name: "xero/sync-now", run: () => xeroSyncNow(req()), poll: pollXeroInvoicePayments },
  { name: "google/sync-now", run: () => googleSyncNow(req()), poll: pollGoogleCalendarChanges },
];

describe("integration sync-now routes — authorization", () => {
  for (const c of cases) {
    it(`${c.name}: non-office/admin → 403 and the sync never runs`, async () => {
      requireOfficeOrAdmin.mockResolvedValue({ ok: false, response: NextResponse.json({ error: "x" }, { status: 403 }) });
      const res = await c.run();
      expect(res.status).toBe(403);
      expect(callerClient).not.toHaveBeenCalled();
      expect(c.poll).not.toHaveBeenCalled();
    });

    it(`${c.name}: office/admin → proceeds through the caller-scoped client to the sync`, async () => {
      requireOfficeOrAdmin.mockResolvedValue({ ok: true, userId: "u1", role: "office" });
      callerClient.mockResolvedValue({ marker: "caller" });
      const res = await c.run();
      expect(callerClient).toHaveBeenCalledTimes(1);
      expect(c.poll).toHaveBeenCalledWith({ marker: "caller" });
      expect(res.status).toBe(200);
    });
  }
});
