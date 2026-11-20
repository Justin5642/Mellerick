import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  KomtraxHttpError,
  KomtraxTablesMissing,
  MIN_URL_GAP_MS,
  fleetPageUrl,
  ranTooRecently,
  recentCalls,
  seriesUrl,
  seriesWindow,
  syncKomtrax,
} from "@/lib/komtrax";

// The Komtrax sync against a fake Komatsu and a fake database. Credentials are
// dummies set for the test only; the assertions check they never leave the
// token request body.

const USER = "test-user@example.invalid";
const PASS = "dummy p@ss&word";
const NOW = Date.parse("2026-11-20T06:47:00Z");

type Q = { table: string; op: string; payload: unknown; opts?: unknown; filters: [string, unknown][] };

function fakeAdmin(init: { state?: Record<string, unknown> | null; missing?: boolean; equipment?: unknown[]; machines?: Record<string, unknown>[] } = {}) {
  const writes: Q[] = [];
  const machines: Record<string, unknown>[] = init.machines ? [...init.machines] : [];
  let n = 0;
  const from = (table: string) => {
    const q: Q = { table, op: "select", payload: null, filters: [] };
    const resolve = () => {
      if (q.op !== "select") {
        writes.push(q);
        if (table === "komtrax_machines" && q.op === "upsert") {
          const row = q.payload as Record<string, unknown>;
          const existing = machines.find((m) => m.make_code === row.make_code && m.model === row.model && m.serial === row.serial);
          if (existing) Object.assign(existing, row);
          else machines.push({ id: `m${++n}`, equipment_id: null, matched_by: null, ...row });
        }
        return { data: null, error: null };
      }
      if (table === "komtrax_sync_state") return init.missing ? { data: null, error: { code: "42P01", message: "missing" } } : { data: init.state ?? null, error: null };
      if (table === "komtrax_machines") return { data: machines, error: null };
      if (table === "equipment") return { data: init.equipment ?? [], error: null };
      return { data: [], error: null };
    };
    const b: Record<string, unknown> = {};
    const chain = () => b;
    Object.assign(b, {
      select: chain, eq: (c: string, v: unknown) => (q.filters.push([c, v]), b), is: (c: string, v: unknown) => (q.filters.push([c, v]), b),
      order: chain, not: chain, gte: chain, in: chain, limit: chain,
      upsert: (p: unknown, o: unknown) => ((q.op = "upsert"), (q.payload = p), (q.opts = o), b),
      update: (p: unknown) => ((q.op = "update"), (q.payload = p), b),
      maybeSingle: async () => resolve(),
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(resolve()).then(res, rej),
    });
    return b;
  };
  return { client: { from } as never, writes, machines };
}

const snapshot = {
  Links: [{ rel: "self", href: "x" }],
  Equipment: [
    {
      EquipmentHeader: { MakeCode: "KOMATSU", Model: "PC88MR-10", SerialNumber: "TEST1001" },
      CumulativeOperatingHours: { datetime: "2026-11-20T00:00:00Z", Hour: 4320 },
      Location: { datetime: "2026-11-20T00:00:00Z", Latitude: -37.6, Longitude: 145.1 },
    },
  ],
};
const hourSeries = { CumulativeOperatingHours: [{ datetime: "2026-11-19T22:00:00Z", Hour: 4318 }, { datetime: "2026-11-20T04:00:00Z", Hour: 4322.5 }] };
const faultSeries = { FaultCodes: [{ CodeIdentifier: "CA2185", datetime: "2026-11-19T23:00:00Z", CodeSeverity: "High" }] };

function fakeKomatsu(over: { token?: number } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith("/token")) return over.token ? new Response("{\"error\":\"invalid_grant\"}", { status: over.token }) : json({ access_token: "tok-123", token_type: "bearer", expires_in: 7199 });
    if (url.endsWith("/Fleet/1")) return json(snapshot);
    if (url.includes("/CumulativeOperatingHours/")) return json(hourSeries);
    if (url.includes("/FaultCode/")) return new Response("", { status: 404 });
    if (url.includes("/FaultCodes/")) return json(faultSeries);
    return new Response("", { status: 404 });
  });
  return { fetchImpl, calls };
}

beforeEach(() => {
  vi.stubEnv("KOMTRAX_USERNAME", USER);
  vi.stubEnv("KOMTRAX_PASSWORD", PASS);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("syncKomtrax", () => {
  it("without credentials: skipped, nothing called", async () => {
    vi.stubEnv("KOMTRAX_USERNAME", "");
    const { client, writes } = fakeAdmin();
    const k = fakeKomatsu();
    expect(await syncKomtrax(client, { fetchImpl: k.fetchImpl, now: () => NOW })).toEqual({ skipped: true, reason: "Komtrax not connected" });
    expect(k.fetchImpl).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("before 0113: says the tables are missing", async () => {
    const { client } = fakeAdmin({ missing: true });
    await expect(syncKomtrax(client, { fetchImpl: fakeKomatsu().fetchImpl, now: () => NOW })).rejects.toBeInstanceOf(KomtraxTablesMissing);
  });

  it("a run under 15 minutes after the last one calls nothing (Komatsu's rate rule)", async () => {
    const { client, writes } = fakeAdmin({ state: { last_run_at: new Date(NOW - 5 * 60_000).toISOString(), url_calls: {} } });
    const k = fakeKomatsu();
    const r = await syncKomtrax(client, { fetchImpl: k.fetchImpl, now: () => NOW });
    expect(r).toMatchObject({ skipped: true });
    expect(k.fetchImpl).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("a full run: token, snapshot, auto-link by serial, readings, faults, state", async () => {
    const { client, writes, machines } = fakeAdmin({
      state: { last_run_at: new Date(NOW - 6 * 3_600_000).toISOString(), url_calls: {} },
      equipment: [{ id: "eq-pc88", name: "PC88 excavator", registration: null, notes: "serial TEST1001", is_active: true }],
    });
    const k = fakeKomatsu();
    const r = await syncKomtrax(client, { fetchImpl: k.fetchImpl, now: () => NOW });

    expect(r).toEqual({ skipped: false, machines: 1, linked: 1, readings: 3, faults: 1, requests: 5, seriesSkipped: 0, seriesFailed: 0 });

    // token: form-encoded password grant, the only place the login goes
    const tokenCall = k.calls[0];
    expect(tokenCall.url).toBe("https://isoapi.komtrax.komatsu/provider/token");
    expect(tokenCall.init?.method).toBe("POST");
    expect((tokenCall.init?.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(String(tokenCall.init?.body));
    expect(Object.fromEntries(form)).toEqual({ grant_type: "password", userName: USER, password: PASS });
    for (const c of k.calls.slice(1)) {
      expect((c.init?.headers as Record<string, string>).Authorization).toBe("Bearer tok-123");
      expect((c.init?.headers as Record<string, string>).Accept).toBe("application/json");
      expect(c.url).not.toContain(PASS);
    }
    expect(k.calls[1].url).toBe(fleetPageUrl(1, "400673"));

    expect(machines[0]).toMatchObject({ id: "m1", serial: "TEST1001", hours: 4320, lat: -37.6 });
    const link = writes.find((w) => w.table === "komtrax_machines" && w.op === "update" && (w.payload as Record<string, unknown>).matched_by);
    expect(link?.payload).toEqual({ equipment_id: "eq-pc88", matched_by: "auto" });

    const readings = writes.find((w) => w.table === "komtrax_hour_readings")!;
    expect(readings.opts).toMatchObject({ ignoreDuplicates: true });
    expect((readings.payload as unknown[]).length).toBe(3);
    const faults = writes.find((w) => w.table === "komtrax_faults")!;
    expect(faults.payload).toEqual([expect.objectContaining({ machine_id: "m1", code: "CA2185", severity: "High" })]);

    // the series reading at 04:00 is newer than the snapshot's 00:00 → becomes the machine's hours
    const hours = writes.find((w) => w.table === "komtrax_machines" && w.op === "update" && "hours" in (w.payload as object));
    expect(hours?.payload).toEqual({ hours: 4322.5, hours_at: "2026-11-20T04:00:00.000Z" });

    const finalState = writes.filter((w) => w.table === "komtrax_sync_state").at(-1)!.payload as Record<string, unknown>;
    expect(finalState).toMatchObject({ last_error: null, last_machines: 1, last_requests: 5 });
    expect(Object.keys(finalState.url_calls as object)).toHaveLength(5);
    expect(JSON.stringify(writes)).not.toContain(PASS);
  });

  it("skips a URL called within 15 minutes, and never relinks what the office decided", async () => {
    const window = seriesWindow(NOW);
    const m = { make_code: "KOMATSU", model: "PC88MR-10", serial: "TEST1001" };
    const recent = new Date(NOW - 10 * 60_000).toISOString();
    const { client, writes } = fakeAdmin({
      state: { last_run_at: new Date(NOW - 20 * 60_000).toISOString(), url_calls: { [seriesUrl(m, "CumulativeOperatingHours", window, "400673")]: recent } },
      machines: [{ id: "m1", ...m, equipment_id: null, matched_by: "office" }],
      equipment: [{ id: "eq-pc88", name: "TEST1001", registration: null, notes: null, is_active: true }],
    });
    const k = fakeKomatsu();
    const r = await syncKomtrax(client, { fetchImpl: k.fetchImpl, now: () => NOW });
    expect(r).toMatchObject({ skipped: false, seriesSkipped: 1, linked: 0 });
    expect(k.calls.some((c) => c.url.includes("/CumulativeOperatingHours/"))).toBe(false);
    expect(writes.some((w) => w.op === "update" && (w.payload as Record<string, unknown>).matched_by)).toBe(false);
  });

  it("a refused login fails with the status only — no credential in the error or the saved state", async () => {
    const { client, writes } = fakeAdmin({ state: null });
    const k = fakeKomatsu({ token: 401 });
    const err = await syncKomtrax(client, { fetchImpl: k.fetchImpl, now: () => NOW }).catch((e) => e);
    expect(err).toBeInstanceOf(KomtraxHttpError);
    expect(err.message).toBe("Komtrax token answered 401");
    const state = writes.filter((w) => w.table === "komtrax_sync_state").at(-1)!.payload as Record<string, unknown>;
    expect(state.last_error).toBe("Komtrax token answered 401");
    expect(JSON.stringify(writes)).not.toContain(PASS);
    expect(JSON.stringify(writes)).not.toContain(USER);
  });
});

describe("rate-rule helpers", () => {
  it("ranTooRecently: under 15 minutes only; a future time (clock moved) doesn't block", () => {
    expect(ranTooRecently(null, NOW)).toBe(false);
    expect(ranTooRecently(new Date(NOW - MIN_URL_GAP_MS + 1000).toISOString(), NOW)).toBe(true);
    expect(ranTooRecently(new Date(NOW - MIN_URL_GAP_MS).toISOString(), NOW)).toBe(false);
    expect(ranTooRecently(new Date(NOW + 3_600_000).toISOString(), NOW)).toBe(false);
  });

  it("recentCalls keeps only calls inside the window", () => {
    const calls = { a: new Date(NOW - 60_000).toISOString(), b: new Date(NOW - 16 * 60_000).toISOString(), c: "junk" };
    expect(Object.keys(recentCalls(calls, NOW))).toEqual(["a"]);
  });

  it("series URLs: UTC midnight two days back to now, segments encoded", () => {
    expect(seriesWindow(NOW)).toEqual({ start: "2026-11-18T00:00:00Z", end: "2026-11-20T06:47:00Z" });
    expect(seriesUrl({ make_code: "KOMATSU", model: "PC 88/MR", serial: "S1" }, "FaultCode", seriesWindow(NOW), "400673")).toBe(
      "https://isoapi.komtrax.komatsu/provider/v1/400673/Fleet/1/Equipment/MakeModelSerial/KOMATSU/PC%2088%2FMR/S1/FaultCode/2026-11-18T00:00:00Z/2026-11-20T06:47:00Z"
    );
  });
});
