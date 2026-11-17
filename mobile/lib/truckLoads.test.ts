// Truck loads on the phone (0111, drafted — not applied yet): online-only calls
// to the web routes with the user's Bearer token, and the form's own checks.

const mockGetSession = jest.fn();
const mockFetch = jest.fn();
jest.mock("./supabase", () => ({ supabase: { auth: { getSession: (...a: unknown[]) => mockGetSession(...a) } } }));
jest.mock("./fetchWithTimeout", () => ({ fetchWithTimeout: (...a: unknown[]) => mockFetch(...a) }));

process.env.EXPO_PUBLIC_API_BASE_URL = "https://office.example";

const tl = require("./truckLoads") as typeof import("./truckLoads");

const jsonResponse = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const defaults = { material_in: "included" as const, spoil_out: "extra" as const };

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSession.mockResolvedValue({ data: { session: { access_token: "tok-123" } } });
});

describe("the calls", () => {
  it("loads, adds, edits, deletes, attaches a docket and signs on the right routes", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { ready: true }));
    const input = tl.loadInputFromDraft({ ...tl.newDraft("spoil_out", "2026-11-17", defaults, [{ id: "t1" }]), quantity: "12", km: "35" });
    if (!input.ok) throw new Error(input.error);
    await tl.loadTruckLoads("job-1");
    await tl.addTruckLoad("job-1", { ...input.input, id: "l1" });
    await tl.updateTruckLoad("job-1", "l1", input.input);
    await tl.deleteTruckLoad("job-1", "l1");
    await tl.attachDocketPhoto("job-1", "l1", "BASE64");
    await tl.signTruckLoads("job-1", ["l1", "l2"], "Sam", "data:image/png;base64,AAA");
    const calls = mockFetch.mock.calls.map(([url, init, timeout]) => [url, init?.method ?? "GET", timeout]);
    expect(calls).toEqual([
      ["https://office.example/api/jobs/job-1/cartage-loads", "GET", undefined],
      ["https://office.example/api/jobs/job-1/cartage-loads", "POST", undefined],
      ["https://office.example/api/jobs/job-1/cartage-loads/l1", "PATCH", undefined],
      ["https://office.example/api/jobs/job-1/cartage-loads/l1", "DELETE", undefined],
      ["https://office.example/api/jobs/job-1/cartage-loads/l1/docket", "POST", 60_000],
      ["https://office.example/api/jobs/job-1/cartage-loads/sign", "POST", undefined],
    ]);
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe("Bearer tok-123");
    expect(JSON.parse(mockFetch.mock.calls[5][1].body)).toEqual({ load_ids: ["l1", "l2"], signer_name: "Sam", signature: "data:image/png;base64,AAA" });
  });

  it("says it needs signal when the request can't be made", async () => {
    mockFetch.mockRejectedValue(new Error("Network request failed"));
    await expect(tl.loadTruckLoads("job-1")).rejects.toThrow(tl.TRUCK_LOADS_OFFLINE);
    try {
      await tl.loadTruckLoads("job-1");
    } catch (e) {
      expect(tl.isTruckLoadsOffline(e)).toBe(true);
    }
  });

  it("surfaces the server's sentence", async () => {
    mockFetch.mockResolvedValue(jsonResponse(409, { error: "This truck load is signed and locked. Ask the office if it needs changing." }));
    await expect(tl.updateTruckLoad("job-1", "l1", {} as never)).rejects.toThrow(/signed and locked/);
  });
});

describe("the form", () => {
  it("defaults: spoil extra, quarry product per the job; one truck picked for you", () => {
    expect(tl.newDraft("spoil_out", "2026-11-17", defaults, [{ id: "t1" }])).toMatchObject({ billing: "extra", equipment_id: "t1", unit: "tonne" });
    expect(tl.newDraft("material_in", "2026-11-17", defaults, [{ id: "t1" }, { id: "t2" }])).toMatchObject({ billing: "included", equipment_id: "" });
    expect(tl.newDraft("material_in", "2026-11-17", { ...defaults, material_in: "extra" }, [])).toMatchObject({ billing: "extra" });
  });

  it("builds the body: quarry only on material in, commas as decimals, blanks as null", () => {
    const d = { ...tl.newDraft("material_in", "2026-11-17", defaults, [{ id: "t1" }]), supplier_id: "q1", place: "Northern Quarries", material: " Crushed rock ", quantity: "20,5", km: "", docket_number: " 88 " };
    expect(tl.loadInputFromDraft(d)).toEqual({
      ok: true,
      input: {
        equipment_id: "t1",
        load_date: "2026-11-17",
        direction: "material_in",
        material: "Crushed rock",
        supplier_id: "q1",
        place: "Northern Quarries",
        from_text: null,
        to_text: null,
        quantity: 20.5,
        unit: "tonne",
        km: null,
        docket_number: "88",
        billing: "included",
      },
    });
    const spoil = tl.loadInputFromDraft({ ...d, direction: "spoil_out" });
    expect(spoil.ok && spoil.input.supplier_id).toBe(null);
    expect(spoil.ok && spoil.input.material).toBe(null);
  });

  it("refuses what the server would", () => {
    const d = tl.newDraft("spoil_out", "2026-11-17", defaults, [{ id: "t1" }]);
    expect(tl.loadInputFromDraft({ ...d, equipment_id: "" })).toEqual({ ok: false, error: "Pick the truck." });
    expect(tl.loadInputFromDraft({ ...d, km: "-3" })).toMatchObject({ ok: false });
    expect(tl.loadInputFromDraft({ ...d, quantity: "abc" })).toMatchObject({ ok: false });
    expect(tl.loadInputFromDraft({ ...d, unit: "load" })).toMatchObject({ ok: false, error: expect.stringMatching(/tonne or m³/) });
    expect(tl.loadInputFromDraft({ ...d, unit: "load", billing: "included" })).toMatchObject({ ok: true });
  });
});

describe("the list", () => {
  const load = (over: Partial<import("./truckLoads").TruckLoad>): import("./truckLoads").TruckLoad => ({
    id: "l1",
    equipment_id: "t1",
    truck: "Tipper",
    load_date: "2026-11-17",
    direction: "spoil_out",
    material: null,
    supplier_id: null,
    place: "Wollert tip",
    from_text: null,
    to_text: null,
    quantity: 12,
    unit: "tonne",
    km: 35,
    docket_number: "1234",
    has_docket_photo: false,
    billing: "extra",
    cost_centre: "Transport",
    status: "draft",
    signer_name: null,
    signed_at: null,
    signature_url: null,
    invoice_id: null,
    void_reason: null,
    created_by: null,
    created_by_name: null,
    ...over,
  });

  it("summarises a load without money, site → tip for spoil and quarry → site for product", () => {
    expect(tl.loadSummary(load({}), "12 Smith St")).toBe("Spoil · 12 t · 12 Smith St → Wollert tip · 35 km · docket 1234");
    expect(tl.loadSummary(load({ direction: "material_in", material: "Quarter minus", place: "Northern Quarries", unit: "m3", quantity: 1, km: null, docket_number: null }), null)).toBe(
      "Quarter minus · 1 m³ · Northern Quarries → job site"
    );
  });

  it("the builder signs the day's draft extras only", () => {
    const loads = [load({ id: "a" }), load({ id: "b", billing: "included" }), load({ id: "c", status: "signed" }), load({ id: "d", load_date: "2026-11-16" })];
    expect(tl.extrasToSign(loads, "2026-11-17").map((l) => l.id)).toEqual(["a"]);
    expect(tl.signProblem([])).toMatch(/No extra/);
    expect(tl.signProblem([load({ quantity: null })])).toMatch(/how much/);
    expect(tl.signProblem([load({})])).toBeNull();
  });

  it("groups newest day first", () => {
    expect(tl.groupLoadsByDate([load({ id: "a", load_date: "2026-11-15" }), load({ id: "b" }), load({ id: "c", load_date: "2026-11-15" })]).map((g) => [g.date, g.loads.map((l) => l.id)])).toEqual([
      ["2026-11-17", ["b"]],
      ["2026-11-15", ["a", "c"]],
    ]);
  });
});
