import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { NextResponse } from "next/server";

// Komtrax routes (0113, drafted — not applied yet):
//   /api/komtrax/sync              GET = cron secret, POST = admin; a refused
//                                  caller never reaches the sync (service role).
//   /api/komtrax/machines/[id]     PATCH link, office/admin, as the CALLER.
//   /api/fleet/[id]/komtrax        GET, office/admin, as the CALLER.
// Every failure is a fixed sentence.

const requireAdmin = vi.fn();
const requireCronSecret = vi.fn();
const requireOfficeOrAdmin = vi.fn();
vi.mock("@/lib/api/guards", () => ({
  requireAdmin: (...a: unknown[]) => requireAdmin(...a),
  requireCronSecret: (...a: unknown[]) => requireCronSecret(...a),
  requireOfficeOrAdmin: (...a: unknown[]) => requireOfficeOrAdmin(...a),
}));
vi.mock("@/lib/monitoring", () => ({ reportError: vi.fn() }));
const adminConstructed = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => (adminConstructed(), {}) }));
const syncKomtrax = vi.fn();
vi.mock("@/lib/komtrax", async (orig) => ({ ...(await orig<typeof import("@/lib/komtrax")>()), syncKomtrax: (...a: unknown[]) => syncKomtrax(...a) }));

type Result = { data?: unknown; error?: unknown };
const writes: { table: string; payload: unknown }[] = [];
let resolve: (table: string, op: string) => Result = () => ({ data: null, error: null });
const callerFrom = vi.fn((table: string) => {
  let op = "select";
  const p: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "not", "gte", "order", "limit", "in"]) p[m] = () => p;
  p.update = (payload: unknown) => ((op = "update"), writes.push({ table, payload }), p);
  p.maybeSingle = async () => resolve(table, op);
  p.then = (ok: (r: Result) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(resolve(table, op)).then(ok, bad);
  return p;
});
vi.mock("@/lib/api/caller-client", () => ({ callerClient: async () => ({ from: callerFrom }) }));

import { GET as cronSync, POST as adminSync } from "@/app/api/komtrax/sync/route";
import { PATCH as linkMachine } from "@/app/api/komtrax/machines/[id]/route";
import { GET as fleetKomtrax } from "@/app/api/fleet/[id]/komtrax/route";
import { KomtraxHttpError, KomtraxTablesMissing } from "@/lib/komtrax";

const MACHINE = "11111111-1111-4111-8111-111111111111";
const EQUIPMENT = "22222222-2222-4222-8222-222222222222";
const ok = { ok: true, userId: "u", role: "office" };
const refused = { ok: false, response: NextResponse.json({ error: "Insufficient permissions" }, { status: 403 }) };
const req = (method: string, body?: unknown) =>
  new NextRequest("http://x/api", { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  writes.length = 0;
  resolve = () => ({ data: null, error: null });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("/api/komtrax/sync", () => {
  it("cron without the secret / non-admin POST: refused before any service-role client", async () => {
    requireCronSecret.mockReturnValue(refused);
    requireAdmin.mockResolvedValue(refused);
    expect((await cronSync(req("GET"))).status).toBe(403);
    expect((await adminSync(req("POST"))).status).toBe(403);
    expect(adminConstructed).not.toHaveBeenCalled();
    expect(syncKomtrax).not.toHaveBeenCalled();
  });

  it("runs the sync and answers its result", async () => {
    requireCronSecret.mockReturnValue({ ok: true });
    syncKomtrax.mockResolvedValue({ skipped: true, reason: "Komtrax not connected" });
    const res = await cronSync(req("GET"));
    expect(await res.json()).toEqual({ skipped: true, reason: "Komtrax not connected" });
  });

  it("before 0113: skipped, not an error", async () => {
    requireAdmin.mockResolvedValue(ok);
    syncKomtrax.mockRejectedValue(new KomtraxTablesMissing());
    expect(await (await adminSync(req("POST"))).json()).toEqual({ skipped: true, reason: "Komtrax tables not found" });
  });

  it("a failure is a fixed sentence", async () => {
    requireAdmin.mockResolvedValue(ok);
    syncKomtrax.mockRejectedValue(new KomtraxHttpError("token", 401));
    const res = await adminSync(req("POST"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Komtrax sync failed" });
  });
});

describe("/api/komtrax/machines/[id] (link)", () => {
  it("refused caller writes nothing", async () => {
    requireOfficeOrAdmin.mockResolvedValue(refused);
    expect((await linkMachine(req("PATCH", { equipment_id: EQUIPMENT }), ctx(MACHINE))).status).toBe(403);
    expect(callerFrom).not.toHaveBeenCalled();
  });

  it("links as the caller, marking it the office's decision", async () => {
    requireOfficeOrAdmin.mockResolvedValue(ok);
    resolve = (table) => (table === "equipment" ? { data: { id: EQUIPMENT }, error: null } : { data: { id: MACHINE, equipment_id: EQUIPMENT, matched_by: "office" }, error: null });
    const res = await linkMachine(req("PATCH", { equipment_id: EQUIPMENT }), ctx(MACHINE));
    expect(res.status).toBe(200);
    expect(writes).toEqual([{ table: "komtrax_machines", payload: { equipment_id: EQUIPMENT, matched_by: "office" } }]);
    expect(adminConstructed).not.toHaveBeenCalled();
  });

  it("unlink is allowed; a bad id or a fleet item already linked gets a fixed sentence", async () => {
    requireOfficeOrAdmin.mockResolvedValue(ok);
    resolve = () => ({ data: { id: MACHINE }, error: null });
    expect((await linkMachine(req("PATCH", { equipment_id: null }), ctx(MACHINE))).status).toBe(200);
    expect(writes.at(-1)?.payload).toEqual({ equipment_id: null, matched_by: "office" });

    expect((await linkMachine(req("PATCH", { equipment_id: "nope" }), ctx(MACHINE))).status).toBe(400);
    expect((await linkMachine(req("PATCH", {}), ctx("not-a-uuid"))).status).toBe(404);

    resolve = (table) => (table === "equipment" ? { data: { id: EQUIPMENT }, error: null } : { data: null, error: { code: "23505", message: "duplicate key value violates komtrax_machines_equipment_key" } });
    const dup = await linkMachine(req("PATCH", { equipment_id: EQUIPMENT }), ctx(MACHINE));
    expect(dup.status).toBe(409);
    expect((await dup.json()).error).toBe("That fleet item is already linked to another Komtrax machine.");
  });
});

describe("/api/fleet/[id]/komtrax", () => {
  it("office/admin only", async () => {
    requireOfficeOrAdmin.mockResolvedValue(refused);
    expect((await fleetKomtrax(req("GET"), ctx(EQUIPMENT))).status).toBe(403);
    expect(callerFrom).not.toHaveBeenCalled();
  });

  it("answers the machine and its faults; a read failure is a fixed sentence", async () => {
    requireOfficeOrAdmin.mockResolvedValue(ok);
    vi.stubEnv("KOMTRAX_USERNAME", "u");
    vi.stubEnv("KOMTRAX_PASSWORD", "p");
    resolve = (table) =>
      table === "komtrax_machines"
        ? { data: { id: MACHINE, make_code: "K", model: "PC88MR-10", serial: "S1", hours: "4320.5", equipment_id: EQUIPMENT }, error: null }
        : { data: [{ id: "f1", code: "CA2185", severity: "High", description: "x", source: null, occurred_at: "2026-11-19T00:00:00Z" }], error: null };
    const body = await (await fleetKomtrax(req("GET"), ctx(EQUIPMENT))).json();
    expect(body).toMatchObject({ connected: true, ready: true, machine: { model: "PC88MR-10", hours: 4320.5 }, faults: [{ code: "CA2185" }] });

    resolve = () => ({ data: null, error: { code: "XX000", message: "secret db text" } });
    const bad = await fleetKomtrax(req("GET"), ctx(EQUIPMENT));
    expect(bad.status).toBe(500);
    expect(JSON.stringify(await bad.json())).not.toContain("secret db text");
    vi.unstubAllEnvs();
  });

  it("without a Komtrax login and no data: not connected", async () => {
    requireOfficeOrAdmin.mockResolvedValue(ok);
    vi.stubEnv("KOMTRAX_USERNAME", "");
    resolve = () => ({ data: null, error: null });
    expect(await (await fleetKomtrax(req("GET"), ctx(EQUIPMENT))).json()).toMatchObject({ connected: false });
    vi.unstubAllEnvs();
  });
});
