// "Today's run" on the phone: the calls (Bearer, online only) and the pure
// helpers the screen and the My Jobs card use. No money anywhere.

const mockGetSession = jest.fn();
const mockFetch = jest.fn();
jest.mock("./supabase", () => ({ supabase: { auth: { getSession: (...a: unknown[]) => mockGetSession(...a) } } }));
jest.mock("./fetchWithTimeout", () => ({ fetchWithTimeout: (...a: unknown[]) => mockFetch(...a) }));

process.env.EXPO_PUBLIC_API_BASE_URL = "https://office.example";

const run = require("./todaysRun") as typeof import("./todaysRun");

const jsonResponse = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSession.mockResolvedValue({ data: { session: { access_token: "tok-1" } } });
});

describe("calls", () => {
  it("loads the run and the card's count from /api/runs/today with the user's token", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { ready: true, date: "2026-11-19", jobs: [] }));
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { ready: true, date: "2026-11-19", jobCount: 3 }));
    await run.loadTodaysRun();
    expect(await run.loadTodaysRunCount()).toBe(3);
    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual(["https://office.example/api/runs/today", "https://office.example/api/runs/today?summary=1"]);
    expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe("Bearer tok-1");
  });

  it("a count missing from the answer is 0; no signal is the offline sentence", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(200, { ready: false, date: "2026-11-19" }));
    expect(await run.loadTodaysRunCount()).toBe(0);
    mockFetch.mockRejectedValueOnce(new Error("Network request failed"));
    const err = await run.loadTodaysRun().catch((e: unknown) => e);
    expect(run.isRunOffline(err)).toBe(true);
  });
});

describe("helpers", () => {
  it("names the card", () => {
    expect(run.runCardTitle(1)).toBe("Today's run (1 job)");
    expect(run.runCardTitle(3)).toBe("Today's run (3 jobs)");
  });

  it("totals read as quantities only, and nothing when no loads", () => {
    expect(run.totalsText({ trips: 3, tonnes: 36, m3: 9.5, km: 90 })).toBe("3 loads · 36 t · 9.5 m³ · 90 km");
    expect(run.totalsText({ trips: 1, tonnes: 0, m3: 0, km: 0 })).toBe("1 load");
    expect(run.totalsText({ trips: 0, tonnes: 0, m3: 0, km: 0 })).toBe("");
  });

  it("a slot reads in Melbourne time, or All day, with its cost centre and stage", () => {
    expect(run.slotText({ bookingId: "b", startIso: "2026-11-18T20:00:00.000Z", endIso: "2026-11-19T04:30:00.000Z", allDay: true, costCentre: "Transport", stage: "Cartage" })).toBe(
      "All day · Transport · Cartage"
    );
    const t = run.slotText({ bookingId: "b", startIso: "2026-11-18T20:00:00.000Z", endIso: "2026-11-18T23:00:00.000Z", allDay: false, costCentre: "Transport", stage: null });
    expect(t).toMatch(/^7:00\s?am – 10:00\s?am · Transport$/i);
  });

  it("the extras to sign are today's drafts marked extra only", () => {
    const base = { load_date: "2026-11-19", status: "draft", billing: "extra" };
    const loads = [
      { ...base, id: "a" },
      { ...base, id: "b", billing: "included" },
      { ...base, id: "c", status: "signed" },
      { ...base, id: "d", load_date: "2026-11-18" },
    ] as never[];
    expect(run.draftExtras({ loads }, "2026-11-19").map((l: { id: string }) => l.id)).toEqual(["a"]);
  });
});
