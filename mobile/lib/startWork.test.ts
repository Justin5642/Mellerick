jest.mock("./supabase", () => ({
  supabase: { auth: { getSession: jest.fn(async () => ({ data: { session: { access_token: "tok" } } })) } },
}));
jest.mock("./fetchWithTimeout", () => ({ fetchWithTimeout: jest.fn() }));

import { fetchWithTimeout } from "./fetchWithTimeout";
import { loadStartStages, startWorkOnJob } from "./startWork";

const fetchMock = fetchWithTimeout as jest.Mock;

beforeEach(() => {
  fetchMock.mockReset();
  process.env.EXPO_PUBLIC_API_BASE_URL = "https://app.example";
});

describe("Start work on this job (0118)", () => {
  it("reads the job's stages from the self-start route with the Bearer token", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ job: { id: "j" }, stages: [], openCount: 0 }) });
    await loadStartStages("j");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://app.example/api/jobs/j/self-start");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("posts the phone's booking id, the stage and the clock-on's entry id", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ booking: { id: "b" }, stage: { id: "cc" } }) });
    const res = await startWorkOnJob("j", { bookingId: "b", costCenterId: "cc", entryId: "e" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://app.example/api/jobs/j/self-start");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ bookingId: "b", costCenterId: "cc", entryId: "e" });
    expect(res.booking.id).toBe("b");
  });

  it("passes the route's own sentence on a refusal", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: "That stage is already complete — pick another, or ask the office." }) });
    await expect(startWorkOnJob("j", { bookingId: "b", costCenterId: "cc", entryId: "e" })).rejects.toThrow(/already complete/);
  });
});
