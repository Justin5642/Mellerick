import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Q3 (Avi's decision): submitting a backflow test to the water authority must be
// IDEMPOTENT — an offline retry can never double-email the authority — while
// office/admin may still deliberately re-send a corrected test via `force`.
// This is the guard that lets the mobile backflow test-log become offline-durable.

const requireUser = vi.fn((..._a: unknown[]) => undefined as unknown);
const isOfficeOrAdmin = vi.fn(async (..._a: unknown[]) => false as boolean);
const renderBackflowPdf = vi.fn(async (..._a: unknown[]) => Buffer.from("pdf"));
const emailSend = vi.fn(async (..._a: unknown[]) => ({ error: null }));

vi.mock("@/lib/api/guards", () => ({ requireUser: (...a: unknown[]) => requireUser(...a) }));
vi.mock("@/lib/api/job-authz", () => ({ isOfficeOrAdmin: (...a: unknown[]) => isOfficeOrAdmin(...a) }));
vi.mock("@/lib/pdf/render-backflow", () => ({ renderBackflowPdf: (...a: unknown[]) => renderBackflowPdf(...a) }));
vi.mock("@/lib/resend", () => ({ getResend: () => ({ emails: { send: emailSend } }), getFromAddress: () => "no-reply@test" }));
vi.mock("@/lib/business-info", () => ({ businessInfo: { name: "Mellerick", email: "office@test" } }));
vi.mock("@/lib/backflow", () => ({
  getWaterAuthorityEmail: () => "authority@water.test",
  getWaterAuthorityLabel: () => "Water Authority",
}));

const upload = vi.fn(async () => ({ error: null }));
const updateEq = vi.fn(async () => ({ error: null }));
const update = vi.fn(() => ({ eq: updateEq }));
let testRow: Record<string, unknown>;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: testRow, error: null }) }) }),
      update,
    }),
    storage: { from: () => ({ upload, download: async () => ({ data: null }) }) },
  }),
}));

import { POST } from "@/app/api/backflow/tests/[id]/submit/route";

const DEVICE = {
  id: "dev-1",
  water_authority: "yvw",
  customers: { name: "Acme" },
  sites: { address_line1: "1 Main St", suburb: "Richmond", state: "VIC", postcode: "3121" },
};

function baseTest(over: Record<string, unknown> = {}) {
  return {
    id: "t1",
    tested_by: "tech-1",
    test_date: "2026-07-27",
    result: "pass",
    test_results: [],
    signature_storage_path: null,
    submitted_to_water_authority_at: null,
    submitted_to_email: null,
    backflow_devices: DEVICE,
    jobs: { job_number: 42 },
    ...over,
  };
}

const req = (body: Record<string, unknown> = {}) =>
  new NextRequest("https://app.test/api/backflow/tests/t1/submit", { method: "POST", body: JSON.stringify(body) });
const params = { params: Promise.resolve({ id: "t1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  requireUser.mockResolvedValue({ ok: true, userId: "tech-1", role: null });
  isOfficeOrAdmin.mockResolvedValue(false);
  testRow = baseTest();
});

describe("backflow submit — water-authority dedupe (Q3)", () => {
  it("sends on the FIRST submit and records the submission", async () => {
    const res = await POST(req(), params);
    expect(res.status).toBe(200);
    expect(emailSend).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ submitted_to_email: "authority@water.test", submitted_to_water_authority_at: expect.any(String) })
    );
  });

  it("does NOT re-email an already-submitted test (offline retry is safe)", async () => {
    testRow = baseTest({ submitted_to_water_authority_at: "2026-07-27T01:00:00.000Z", submitted_to_email: "authority@water.test" });
    const res = await POST(req(), params);

    // Idempotent SUCCESS so a queued offline retry completes instead of failing forever.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, alreadySubmitted: true, sentTo: "authority@water.test" });
    expect(emailSend).not.toHaveBeenCalled(); // the whole point — no double-email
    expect(renderBackflowPdf).not.toHaveBeenCalled(); // and no wasted PDF/upload work
    expect(upload).not.toHaveBeenCalled();
  });

  it("lets an OFFICE/ADMIN force a deliberate re-send of a corrected test", async () => {
    testRow = baseTest({ submitted_to_water_authority_at: "2026-07-27T01:00:00.000Z", submitted_to_email: "authority@water.test" });
    isOfficeOrAdmin.mockResolvedValue(true);

    const res = await POST(req({ force: true }), params);
    expect(res.status).toBe(200);
    expect(emailSend).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body.alreadySubmitted).toBeUndefined(); // a real re-send, not the short-circuit
  });

  it("does NOT let a TECHNICIAN force a re-send to the water authority", async () => {
    testRow = baseTest({ submitted_to_water_authority_at: "2026-07-27T01:00:00.000Z", submitted_to_email: "authority@water.test" });
    isOfficeOrAdmin.mockResolvedValue(false); // the tester, but not office/admin

    const res = await POST(req({ force: true }), params);
    expect(res.status).toBe(403);
    expect(emailSend).not.toHaveBeenCalled();
  });

  it("still rejects a caller who neither performed the test nor is office/admin", async () => {
    requireUser.mockResolvedValue({ ok: true, userId: "someone-else", role: null });
    isOfficeOrAdmin.mockResolvedValue(false);
    const res = await POST(req(), params);
    expect(res.status).toBe(403);
    expect(emailSend).not.toHaveBeenCalled();
  });
});
