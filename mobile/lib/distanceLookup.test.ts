jest.mock("./supabase", () => ({
  supabase: { auth: { getSession: jest.fn(async () => ({ data: { session: { access_token: "tok" } } })) } },
}));
jest.mock("./fetchWithTimeout", () => ({ fetchWithTimeout: jest.fn() }));

import { fetchWithTimeout } from "./fetchWithTimeout";
import { lookupDistance, shouldFillKm } from "./distanceLookup";

const fetchMock = fetchWithTimeout as jest.Mock;

beforeEach(() => {
  fetchMock.mockReset();
  process.env.EXPO_PUBLIC_API_BASE_URL = "https://app.example";
});

describe("lookupDistance", () => {
  it("posts both ends and the job with the Bearer token", async () => {
    const answer = { km: 23.4, from: { label: "Boral Wollert", precise: true }, to: { label: "12 Smith St", precise: true }, approximate: false };
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => answer });
    await expect(lookupDistance("job-1", { from: "Boral Wollert", to: "site" })).resolves.toEqual(answer);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://app.example/api/distance");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body)).toEqual({ from: "Boral Wollert", to: "site", jobId: "job-1" });
  });

  it("passes the server's sentence through, and says it needs signal offline", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: "No road route found between those places — type the km in." }) });
    await expect(lookupDistance("j", { from: "a", to: "b" })).rejects.toThrow("No road route found");
    fetchMock.mockRejectedValueOnce(new Error("Network request failed"));
    await expect(lookupDistance("j", { from: "a", to: "b" })).rejects.toThrow(/needs signal/);
  });
});

describe("shouldFillKm", () => {
  it("fills only when the box is unchanged since the press", () => {
    expect(shouldFillKm("", "")).toBe(true);
    expect(shouldFillKm("35", "35")).toBe(true);
    expect(shouldFillKm("", "4")).toBe(false);
  });
});
