// "Log mistake" on the phone (0119, a draft not applied yet): online calls with the user's Bearer token,
// and the form rules mirrored from the web (lib/mistakeRaise.ts).

const mockGetSession = jest.fn();
const mockFetch = jest.fn();
jest.mock("./supabase", () => ({ supabase: { auth: { getSession: (...a: unknown[]) => mockGetSession(...a) } } }));
jest.mock("./fetchWithTimeout", () => ({ fetchWithTimeout: (...a: unknown[]) => mockFetch(...a) }));

process.env.EXPO_PUBLIC_API_BASE_URL = "https://office.example";

const api = require("./mistakes") as typeof import("./mistakes");
const rules = require("./mistakeRaise") as typeof import("./mistakeRaise");

const jsonResponse = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const ID = "33333333-3333-4333-8333-333333333333";
const CAT = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSession.mockResolvedValue({ data: { session: { access_token: "tok-1" } } });
});

describe("the calls", () => {
  it("loads, raises and adds a photo on the right routes with the Bearer token", async () => {
    mockFetch.mockResolvedValue(jsonResponse(200, { ready: true }));
    const body = { id: ID, categoryId: CAT, causeCode: null, costCenterId: null, description: "Pit high", occurredOn: null, timeEntryIds: [] };
    await api.loadMistakes("job-1");
    await api.raiseMistake("job-1", body);
    await api.addMistakePhoto("job-1", ID, "/9j/AAA");
    const calls = mockFetch.mock.calls.map(([url, init]) => [url, init.method ?? "GET", init.body && JSON.parse(init.body), init.headers.Authorization]);
    expect(calls).toEqual([
      ["https://office.example/api/jobs/job-1/mistakes", "GET", undefined, "Bearer tok-1"],
      ["https://office.example/api/jobs/job-1/mistakes", "POST", body, "Bearer tok-1"],
      [`https://office.example/api/jobs/job-1/mistakes/${ID}/photos`, "POST", { image: "/9j/AAA" }, "Bearer tok-1"],
    ]);
  });

  it("says it needs signal when the request can't go", async () => {
    mockFetch.mockRejectedValue(new TypeError("Network request failed"));
    const err = await api.loadMistakes("job-1").catch((e) => e);
    expect(err.message).toMatch(/needs signal/);
    expect(api.isMistakesOffline(err)).toBe(true);
  });

  it("surfaces the server's sentence", async () => {
    mockFetch.mockResolvedValue(jsonResponse(403, { error: "This job isn't one of yours." }));
    await expect(api.loadMistakes("job-1")).rejects.toThrow("This job isn't one of yours.");
  });
});

describe("the form (mirrored rules)", () => {
  it("builds the request or says what's missing", () => {
    const form = { ...rules.emptyRaiseForm(), categoryId: CAT, description: " Broke the riser " };
    expect(rules.buildRaiseBody(ID, form, "2026-11-25")).toMatchObject({ ok: true, body: { description: "Broke the riser", causeCode: null } });
    expect(rules.buildRaiseBody(ID, { ...form, categoryId: "" }, "2026-11-25")).toEqual({ ok: false, error: "Pick what kind of mistake it was." });
  });
});
