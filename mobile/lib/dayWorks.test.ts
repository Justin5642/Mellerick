// Day Works on the phone (Stage 2): online-only calls to the web routes with
// the user's Bearer token, and the form's own checks.

const mockGetSession = jest.fn();
const mockFetch = jest.fn();
jest.mock("./supabase", () => ({ supabase: { auth: { getSession: (...a: unknown[]) => mockGetSession(...a) } } }));
jest.mock("./fetchWithTimeout", () => ({ fetchWithTimeout: (...a: unknown[]) => mockFetch(...a) }));

process.env.EXPO_PUBLIC_API_BASE_URL = "https://office.example";

const dw = require("./dayWorks") as typeof import("./dayWorks");

const jsonResponse = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

const machines: import("./dayWorks").DayWorksMachine[] = [
  { id: "bobcat", name: "Bobcat", options: [{ hire_type: "wet", hire_unit: "hour", label: "Wet hire, per hour", whole_days_only: false, fuel_included: true }] },
  { id: "roller", name: "Roller", options: [{ hire_type: "dry", hire_unit: "day", label: "Dry hire, per day", whole_days_only: true, fuel_included: false }] },
  { id: "float", name: "Quad float", options: [{ hire_type: "float", hire_unit: "move", label: "Float move", whole_days_only: false, fuel_included: false }] },
  { id: "pc35", name: "PC35", options: [{ hire_type: "dry", hire_unit: "engine_hour", label: "Dry hire, per engine hour", whole_days_only: false, fuel_included: false }] },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSession.mockResolvedValue({ data: { session: { access_token: "tok-123" } } });
});

describe("the calls", () => {
  it("loads the tab with the user's Bearer token", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { ready: true, entries: [] }));
    await dw.loadDayWorks("job-1");
    expect(mockFetch).toHaveBeenCalledWith("https://office.example/api/jobs/job-1/hire-entries", {
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok-123" },
    });
  });

  it("adds, edits, deletes and signs on the right routes", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { ready: true }));
    const input = { equipment_id: "bobcat", hire_type: "wet" as const, hire_unit: "hour" as const, work_date: "2026-11-16", hours: 6, days: null, meter_open: null, meter_close: null, km: null, pickup: null, dropoff: null, description: null, attachment_ids: [] };
    await dw.addDayWorksEntry("job-1", { ...input, id: "e1" });
    await dw.updateDayWorksEntry("job-1", "e1", input);
    await dw.deleteDayWorksEntry("job-1", "e1");
    await dw.signDayWorksEntry("job-1", "e1", "Sam", "iVBOR");
    const calls = mockFetch.mock.calls.map(([url, init]) => [url, init.method, init.body && JSON.parse(init.body)]);
    expect(calls).toEqual([
      ["https://office.example/api/jobs/job-1/hire-entries", "POST", { ...input, id: "e1" }],
      ["https://office.example/api/jobs/job-1/hire-entries/e1", "PATCH", input],
      ["https://office.example/api/jobs/job-1/hire-entries/e1", "DELETE", undefined],
      ["https://office.example/api/jobs/job-1/hire-entries/e1/sign", "POST", { signer_name: "Sam", signature: "iVBOR" }],
    ]);
  });

  it("says Day Works needs signal when the request can't go", async () => {
    mockFetch.mockRejectedValue(new TypeError("Network request failed"));
    const err = await dw.loadDayWorks("job-1").catch((e) => e);
    expect(err.message).toMatch(/Day Works needs signal/);
    expect(dw.isOfflineError(err)).toBe(true);
  });

  it("surfaces the server's sentence, or the status when there isn't one", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(409, { error: "This entry was already signed or removed. Refresh to see it." }));
    await expect(dw.signDayWorksEntry("job-1", "e1", "Sam", "x")).rejects.toThrow(/already signed/);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 502, json: async () => { throw new Error("html"); } });
    const err = await dw.loadDayWorks("job-1").catch((e) => e);
    expect(err.message).toMatch(/502/);
    expect(dw.isOfflineError(err)).toBe(false);
  });

  it("asks to sign in again with no session, without calling the server", async () => {
    mockGetSession.mockResolvedValue({ data: { session: null } });
    await expect(dw.loadDayWorks("job-1")).rejects.toThrow(/session has expired/);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("machines with no hire rate yet", () => {
  // The server now lists the whole fleet; an unpriced machine comes with no options.
  const all = [...machines, { id: "pc180", name: "Komatsu PC180", options: [] }];

  it("splits pickable machines from those waiting for a rate", () => {
    const { ready, noRate } = dw.splitMachinesByHire(all);
    expect(ready.map((m) => m.id)).toEqual(["bobcat", "roller", "float", "pc35"]);
    expect(noRate.map((m) => m.id)).toEqual(["pc180"]);
  });

  it("refuses a draft on a machine with no hire rate", () => {
    expect(dw.entryInputFromDraft({ ...dw.emptyDraft("2026-11-16"), equipment_id: "pc180", optionKey: "wet|hour", hours: "4" }, all)).toEqual({
      ok: false,
      error: "Pick the machine and how it's hired.",
    });
  });
});

describe("entryInputFromDraft — the web form's rules", () => {
  const draft = (over: Partial<import("./dayWorks").DayWorksDraft>) => ({ ...dw.emptyDraft("2026-11-16"), ...over });

  it("keeps only the fields for the hire unit", () => {
    const r = dw.entryInputFromDraft(draft({ equipment_id: "bobcat", optionKey: "wet|hour", hours: "6,5", days: "2", km: "9", description: " Trenching ", attachment_ids: ["t1"] }), machines);
    expect(r).toEqual({
      ok: true,
      input: { equipment_id: "bobcat", hire_type: "wet", hire_unit: "hour", work_date: "2026-11-16", hours: 6.5, days: null, meter_open: null, meter_close: null, km: null, pickup: null, dropoff: null, description: "Trenching", attachment_ids: ["t1"] },
    });
  });

  it("keeps km, from and to for a float, and drops attachments", () => {
    const r = dw.entryInputFromDraft(draft({ id: "e1", equipment_id: "float", optionKey: "float|move", km: "52", pickup: "Depot", dropoff: "Lot 12", attachment_ids: ["t1"] }), machines);
    expect(r.ok && r.input).toMatchObject({ id: "e1", km: 52, pickup: "Depot", dropoff: "Lot 12", attachment_ids: [] });
  });

  it("keeps meter readings for an engine-hour dry hire", () => {
    const r = dw.entryInputFromDraft(draft({ equipment_id: "pc35", optionKey: "dry|engine_hour", meter_open: "1200.5", meter_close: "1207" }), machines);
    expect(r.ok && r.input).toMatchObject({ meter_open: 1200.5, meter_close: 1207, hours: null });
  });

  it("refuses what the server would refuse", () => {
    expect(dw.entryInputFromDraft(draft({}), machines)).toEqual({ ok: false, error: "Pick the machine and how it's hired." });
    expect(dw.entryInputFromDraft(draft({ equipment_id: "bobcat", optionKey: "wet|hour", work_date: "" }), machines)).toEqual({ ok: false, error: "Pick the date." });
    expect(dw.entryInputFromDraft(draft({ equipment_id: "roller", optionKey: "dry|day", days: "1.5" }), machines)).toEqual({ ok: false, error: "This machine is hired in full days only." });
    expect(dw.entryInputFromDraft(draft({ equipment_id: "bobcat", optionKey: "wet|hour", hours: "-2" }), machines)).toEqual({ ok: false, error: "Check the numbers entered." });
    expect(dw.entryInputFromDraft(draft({ equipment_id: "bobcat", optionKey: "wet|hour", hours: "26" }), machines).ok).toBe(false);
  });
});

describe("display helpers", () => {
  const e = { hire_unit: "hour" as const, hours: 6.5, days: null, meter_open: null, meter_close: null, km: null, pickup: null, dropoff: null };

  it("says what was done, in the web tab's words", () => {
    expect(dw.quantityText(e)).toBe("6.5 h");
    expect(dw.quantityText({ ...e, hire_unit: "engine_hour", meter_open: 100, meter_close: 106.5 })).toBe("Meter 100 → 106.5 (6.5 engine h)");
    expect(dw.quantityText({ ...e, hire_unit: "move", km: 52, pickup: "Depot", dropoff: "Lot 12" })).toBe("Depot → Lot 12 · 52 km loaded");
  });

  it("won't let an entry go to sign-off without its quantity", () => {
    expect(dw.quantityProblem({ ...e, hours: null })).toBe("Enter the hours.");
    expect(dw.quantityProblem(e)).toBeNull();
    expect(dw.quantityProblem({ ...e, hire_unit: "move", km: 0 })).toBeNull();
    expect(dw.quantityProblem({ ...e, hire_unit: "engine_hour", meter_open: 5, meter_close: 5 })).toMatch(/higher/);
  });

  it("groups by day, newest first, and formats the day without shifting it", () => {
    const entry = (id: string, work_date: string) => ({ id, work_date }) as import("./dayWorks").DayWorksEntry;
    const groups = dw.groupByDate([entry("a", "2026-11-14"), entry("b", "2026-11-16"), entry("c", "2026-11-14")]);
    expect(groups.map((g) => [g.date, g.entries.map((x) => x.id)])).toEqual([
      ["2026-11-16", ["b"]],
      ["2026-11-14", ["a", "c"]],
    ]);
    expect(dw.formatWorkDate("2026-11-16")).toBe("Mon 16 Nov 2026");
  });
});
