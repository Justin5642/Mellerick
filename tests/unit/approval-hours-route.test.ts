import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// GET /api/approvals/hours — the phone's Approvals screen shows the hours each
// pending job will carry onto its invoice, the same figures the web page
// computes on the server (lib/invoice-hours.ts approvalHoursByJob).

let guardResult: any = { ok: true, userId: "u1", role: "office" };
vi.mock("@/lib/api/guards", () => ({ requireOfficeOrAdmin: async () => guardResult }));

let tables: Record<string, { data: unknown; error: unknown }> = {};
function fakeDb() {
  return {
    from: (table: string) => {
      const result = tables[table] ?? { data: [], error: null };
      const q: any = new Proxy({}, {
        get(_t, prop) {
          if (prop === "then") return (res: (v: unknown) => void) => res(result);
          return () => q;
        },
      });
      return q;
    },
  };
}
const callerClient = vi.fn(async () => fakeDb());
vi.mock("@/lib/api/caller-client", () => ({ callerClient: () => callerClient() }));

import { GET } from "@/app/api/approvals/hours/route";
import { parseApprovalJobIds } from "@/lib/invoice-hours";

const J1 = "11111111-1111-4111-8111-111111111111";
const J2 = "22222222-2222-4222-8222-222222222222";
const req = (q: string) => new NextRequest(`http://localhost/api/approvals/hours${q}`);

beforeEach(() => {
  guardResult = { ok: true, userId: "u1", role: "office" };
  callerClient.mockClear();
  tables = {
    time_entries: {
      data: [
        { id: "e1", job_id: J1, staff_id: "s1", entry_type: "work", clock_in: "2026-11-18T22:00:00Z", clock_out: "2026-11-19T02:00:00Z", cost_center_id: null, invoice_id: null, profiles: { full_name: "Dave" }, po_cost_centers: null },
        // Already on an invoice — not carried again.
        { id: "e2", job_id: J1, staff_id: "s1", entry_type: "work", clock_in: "2026-11-17T22:00:00Z", clock_out: "2026-11-18T00:00:00Z", cost_center_id: null, invoice_id: "inv", profiles: { full_name: "Dave" }, po_cost_centers: null },
      ],
      error: null,
    },
    job_items: { data: [], error: null },
  };
});

describe("GET /api/approvals/hours", () => {
  it("is office/admin only: the guard's refusal is returned and nothing is read", async () => {
    guardResult = { ok: false, response: NextResponse.json({ error: "Insufficient permissions" }, { status: 403 }) };
    const res = await GET(req(`?jobIds=${J1}`));
    expect(res.status).toBe(403);
    expect(callerClient).not.toHaveBeenCalled();
  });

  it("refuses a missing or malformed id list", async () => {
    expect((await GET(req(""))).status).toBe(400);
    expect((await GET(req("?jobIds=nope"))).status).toBe(400);
  });

  it("returns each job's unbilled hours, grouped — no money", async () => {
    const res = await GET(req(`?jobIds=${J1},${J2}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hoursByJob[J1].total).toBe(4);
    expect(body.hoursByJob[J1].groups[0]).toMatchObject({ staffName: "Dave", hours: 4, costCentreName: null });
    expect(body.hoursByJob[J2]).toEqual({ groups: [], total: 0, error: null });
    expect(JSON.stringify(body)).not.toMatch(/rate|price|amount|total_amount/i);
  });

  it("a failed read says so per job, with a fixed sentence", async () => {
    tables.time_entries = { data: null, error: { message: 'permission denied for column "secret"' } };
    const body = await (await GET(req(`?jobIds=${J1}`))).json();
    expect(body.hoursByJob[J1].error).toBeTruthy();
    expect(JSON.stringify(body)).not.toContain("permission denied");
  });
});

describe("parseApprovalJobIds", () => {
  it("dedupes and validates", () => {
    expect(parseApprovalJobIds(`${J1}, ${J1},${J2}`)).toEqual([J1, J2]);
    expect(parseApprovalJobIds(null)).toBeNull();
    expect(parseApprovalJobIds(`${J1},x`)).toBeNull();
  });
});
