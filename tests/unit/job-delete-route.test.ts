import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// DELETE /api/jobs/[id] — the web dialog and the phone share it. Admin only,
// run as the caller (never the service role), fixed sentences out.

const requireAdmin = vi.fn();
const deletes: string[] = [];
let result: { error: { code?: string; message: string } | null; count: number | null } = { error: null, count: 1 };

vi.mock("@/lib/api/guards", () => ({ requireAdmin: (...a: unknown[]) => requireAdmin(...a) }));
vi.mock("@/lib/monitoring", () => ({ reportError: vi.fn() }));
const adminConstructed = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => { adminConstructed(); return {}; } }));
vi.mock("@/lib/api/caller-client", () => ({
  callerClient: async () => ({
    from: (table: string) => ({
      delete: () => ({
        eq: async (_col: string, id: string) => {
          deletes.push(`${table}:${id}`);
          return result;
        },
      }),
    }),
  }),
}));

import { DELETE } from "@/app/api/jobs/[id]/route";

const call = () => DELETE(new NextRequest("http://localhost/api/jobs/job-1", { method: "DELETE" }), { params: Promise.resolve({ id: "job-1" }) });

beforeEach(() => {
  vi.clearAllMocks();
  deletes.length = 0;
  result = { error: null, count: 1 };
});

describe("DELETE /api/jobs/[id]", () => {
  it("refuses anyone the admin guard refuses, before touching the database", async () => {
    requireAdmin.mockResolvedValue({ ok: false, response: new Response("{}", { status: 403 }) });
    expect((await call()).status).toBe(403);
    expect(deletes).toEqual([]);
  });

  it("deletes the job as the caller, never with the service role", async () => {
    requireAdmin.mockResolvedValue({ ok: true, userId: "admin-1", role: "admin" });
    const res = await call();
    expect(res.status).toBe(200);
    expect(deletes).toEqual(["jobs:job-1"]);
    expect(adminConstructed).not.toHaveBeenCalled();
  });

  it("answers a linked quote or invoice (23503) with the dialog's sentence", async () => {
    requireAdmin.mockResolvedValue({ ok: true, userId: "admin-1", role: "admin" });
    result = { error: { code: "23503", message: 'violates foreign key constraint "invoices_job_id_fkey"' }, count: null };
    const res = await call();
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/linked quote or invoice/);
    expect(body.error).not.toMatch(/constraint/);
  });

  it("says so when nothing was deleted", async () => {
    requireAdmin.mockResolvedValue({ ok: true, userId: "admin-1", role: "admin" });
    result = { error: null, count: 0 };
    expect((await call()).status).toBe(404);
  });

  it("never returns raw database text", async () => {
    requireAdmin.mockResolvedValue({ ok: true, userId: "admin-1", role: "admin" });
    result = { error: { code: "42501", message: "permission denied for table jobs" }, count: null };
    const res = await call();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Couldn't delete the job. Try again.");
  });
});
