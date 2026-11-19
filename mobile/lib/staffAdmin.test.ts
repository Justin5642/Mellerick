jest.mock("./supabase", () => ({
  supabase: { auth: { getSession: jest.fn(async () => ({ data: { session: { access_token: "tok" } } })) } },
}));
jest.mock("./fetchWithTimeout", () => ({ fetchWithTimeout: jest.fn() }));

import { fetchWithTimeout } from "./fetchWithTimeout";
import { autoClockEnabled, inviteStaff, loginDetailsChanged, setAutoClock, staffFormProblem, updateStaffLogin } from "./staffAdmin";

const fetchMock = fetchWithTimeout as jest.Mock;
const ok = () => fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ success: true }) });

beforeEach(() => {
  fetchMock.mockReset();
  process.env.EXPO_PUBLIC_API_BASE_URL = "https://app.example";
});

describe("staff admin calls", () => {
  it("invites through the web route with the Bearer token, email lowercased", async () => {
    ok();
    await inviteStaff({ full_name: " Jake ", email: " Jake@Mellerick.COM ", phone: "", role: "technician" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://app.example/api/staff/invite");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer tok");
    expect(JSON.parse(init.body)).toEqual({ full_name: "Jake", email: "jake@mellerick.com", phone: "", role: "technician" });
  });

  it("edits the login email through /api/staff/update", async () => {
    ok();
    await updateStaffLogin({ id: "u1", full_name: "Jake", email: "New@X.com", phone: "0400", role: "office" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://app.example/api/staff/update");
    expect(JSON.parse(init.body)).toMatchObject({ id: "u1", email: "new@x.com", role: "office" });
  });

  it("passes the server's fixed sentence through", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: "Someone with this email already has a login." }) });
    await expect(inviteStaff({ full_name: "J", email: "j@x.com", phone: "", role: "technician" })).rejects.toThrow("Someone with this email already has a login.");
  });

  it("switches auto clock", async () => {
    ok();
    await setAutoClock("u1", false);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ id: "u1", enabled: false });
  });
});

describe("rules", () => {
  it("auto clock: by role until an admin chooses", () => {
    expect(autoClockEnabled({ role: "technician" })).toBe(true);
    expect(autoClockEnabled({ role: "office", auto_clock: null })).toBe(false);
    expect(autoClockEnabled({ role: "technician", auto_clock: false })).toBe(false);
    expect(autoClockEnabled({ role: "admin", auto_clock: true })).toBe(true);
  });

  it("form problems", () => {
    expect(staffFormProblem({ full_name: "", email: "a@b.co" })).toMatch(/name/);
    expect(staffFormProblem({ full_name: "Jake", email: "jake" })).toMatch(/email/);
    expect(staffFormProblem({ full_name: "Jake", email: "jake@x.com" })).toBeNull();
  });

  it("only a changed name or email needs the update route", () => {
    expect(loginDetailsChanged({ full_name: "Jake", email: "jake@x.com" }, { full_name: "Jake ", email: "JAKE@x.com" })).toBe(false);
    expect(loginDetailsChanged({ full_name: "Jake", email: "jake@x.com" }, { full_name: "Jake", email: "jake2@x.com" })).toBe(true);
  });
});
