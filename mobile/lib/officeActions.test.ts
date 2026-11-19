jest.mock("./supabase", () => ({ supabase: { auth: { getSession: jest.fn(async () => ({ data: { session: { access_token: "tok" } } })) } } }));
jest.mock("./fetchWithTimeout", () => ({ fetchWithTimeout: jest.fn() }));

import { fetchWithTimeout } from "./fetchWithTimeout";
import { deleteJob, deleteJobMessage, formatPin, geocodeSiteAddress, parseUsageAmounts, pinFixProblem, siteAddress } from "./officeActions";

const fetchMock = fetchWithTimeout as jest.Mock;
const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

beforeAll(() => {
  process.env.EXPO_PUBLIC_API_BASE_URL = "https://app.example";
});
afterEach(() => fetchMock.mockReset());

describe("deleteJob", () => {
  it("calls the web's admin route with the user's token", async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true }));
    await deleteJob("job-1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/jobs\/job-1$/);
    expect(init.method).toBe("DELETE");
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("throws the server's own sentence (a linked quote or invoice)", async () => {
    fetchMock.mockResolvedValue(reply(409, { error: "This job has a linked quote or invoice — remove or unlink that first, then delete the job." }));
    await expect(deleteJob("job-1")).rejects.toThrow(/linked quote or invoice/);
  });

  it("says a delete needs signal when the request never left", async () => {
    fetchMock.mockRejectedValue(new TypeError("Network request failed"));
    await expect(deleteJob("job-1")).rejects.toThrow(/needs signal/);
  });

  it("keeps the web dialog's wording", () => {
    expect(deleteJobMessage("Blocked drain")).toMatch(/permanently deletes "Blocked drain" along with all of its notes, photos, documents, time entries, expenses, and variations/);
    expect(deleteJobMessage("x")).toMatch(/can't be undone/);
  });
});

describe("siteAddress (the web's lib/geocode.ts rule)", () => {
  it("drops a unit or lot prefix and adds the locality and country", () => {
    expect(siteAddress({ address_line1: "Lot 12 Smith St", suburb: "Craigieburn", state: "VIC", postcode: "3064" })).toBe("Smith St, Craigieburn VIC 3064, Australia");
    expect(siteAddress({ address_line1: "3/45 High St", suburb: "Epping", state: "VIC", postcode: "3076" })).toBe("45 High St, Epping VIC 3076, Australia");
  });
  it("is null with no street", () => {
    expect(siteAddress({ address_line1: "  ", suburb: "Epping" })).toBeNull();
  });
});

describe("geocodeSiteAddress", () => {
  it("asks for a precise match (never approx) and returns the point", async () => {
    fetchMock.mockResolvedValue(reply(200, { lat: -37.6, lng: 144.9, display: "12 Smith St", precise: true }));
    expect(await geocodeSiteAddress("12 Smith St, Craigieburn VIC 3064, Australia")).toEqual({ lat: -37.6, lng: 144.9, display: "12 Smith St" });
    expect(fetchMock.mock.calls[0][0]).toContain("/api/geocode?address=12%20Smith%20St");
    expect(fetchMock.mock.calls[0][0]).not.toContain("approx");
  });
  it("passes on the server's not-found sentence", async () => {
    fetchMock.mockResolvedValue(reply(404, { error: "Couldn't find that exact address" }));
    await expect(geocodeSiteAddress("x")).rejects.toThrow("Couldn't find that exact address");
  });
});

describe("pinFixProblem", () => {
  it("accepts a fix within ±50 m", () => {
    expect(pinFixProblem({ latitude: -37.6, longitude: 144.9, accuracy: 12 })).toBeNull();
    expect(pinFixProblem({ latitude: -37.6, longitude: 144.9, accuracy: 50 })).toBeNull();
  });
  it("refuses a vague, missing or null-island fix", () => {
    expect(pinFixProblem({ latitude: -37.6, longitude: 144.9, accuracy: 51 })).toMatch(/±51 m/);
    expect(pinFixProblem({ latitude: -37.6, longitude: 144.9, accuracy: null })).toMatch(/isn't accurate enough/);
    expect(pinFixProblem({ latitude: 0, longitude: 0, accuracy: 5 })).toMatch(/Couldn't get a fix/);
    expect(pinFixProblem(null)).toMatch(/Couldn't get a fix/);
  });
  it("formats a pin as the web dialog does", () => {
    expect(formatPin(-37.813612, 144.963099)).toBe("-37.81361, 144.96310");
  });
});

describe("parseUsageAmounts (0091: hours and/or loads)", () => {
  it("takes hours, loads, or both", () => {
    expect(parseUsageAmounts("2.5", "")).toEqual({ hours: 2.5, loads: 0 });
    expect(parseUsageAmounts("", "3")).toEqual({ hours: 0, loads: 3 });
    expect(parseUsageAmounts("0", "3")).toEqual({ hours: 0, loads: 3 });
    expect(parseUsageAmounts("4", "2")).toEqual({ hours: 4, loads: 2 });
  });
  it("needs one of them above 0", () => {
    expect(parseUsageAmounts("", "")).toEqual({ error: expect.stringMatching(/hours, the loads carted, or both/) });
    expect(parseUsageAmounts("0", "0")).toEqual({ error: expect.any(String) });
  });
  it("refuses negatives, junk and part loads", () => {
    expect(parseUsageAmounts("-1", "2")).toEqual({ error: expect.stringMatching(/Hours/) });
    expect(parseUsageAmounts("abc", "")).toEqual({ error: expect.stringMatching(/Hours/) });
    expect(parseUsageAmounts("1", "1.5")).toEqual({ error: expect.stringMatching(/whole number/) });
  });
});
