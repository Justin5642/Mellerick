jest.mock("./supabase", () => ({
  supabase: { auth: { getSession: jest.fn(async () => ({ data: { session: { access_token: "tok" } } })) } },
}));
jest.mock("./fetchWithTimeout", () => ({ fetchWithTimeout: jest.fn() }));

import { fetchWithTimeout } from "./fetchWithTimeout";
import { OfficeApiError } from "./officeApi";
import {
  applyHourlyRate,
  initialRateForm,
  loadApprovalHours,
  rateFormProblem,
  rateTargets,
  type HoursGroup,
} from "./approvalHours";

const fetchMock = fetchWithTimeout as jest.Mock;
const respond = (status: number, body: unknown) =>
  fetchMock.mockResolvedValueOnce({ ok: status < 400, status, json: async () => body });

const g = (over: Partial<HoursGroup>): HoursGroup => ({
  key: "none|s1",
  costCentreKey: "none",
  costCentreName: null,
  staffId: "s1",
  staffName: "Dave",
  hours: 4,
  entryIds: ["e1"],
  ...over,
});

beforeEach(() => {
  fetchMock.mockReset();
  process.env.EXPO_PUBLIC_API_BASE_URL = "https://app.example";
});

describe("loadApprovalHours", () => {
  it("asks the server for every pending job at once, with the Bearer token", async () => {
    respond(200, { hoursByJob: { j1: { groups: [g({})], total: 4, error: null } } });
    const r = await loadApprovalHours(["j1", "j2"]);
    expect(r.j1.total).toBe(4);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://app.example/api/approvals/hours?jobIds=j1%2Cj2");
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("asks nothing for an empty queue", async () => {
    expect(await loadApprovalHours([])).toEqual({});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("the rate form", () => {
  const groups = [g({}), g({ key: "cc1|s2", costCentreKey: "cc1", costCentreName: "Sewer", staffId: "s2", staffName: "Sam" })];

  it("opens on the server's defaults", () => {
    const form = initialRateForm({
      defaults: {
        all: 120,
        allSource: "company",
        byStaff: { s1: { rate: 130, source: "charge_out" }, s2: { rate: 120, source: "company" } },
        byCostCentre: { none: { rate: 120, source: "company" }, cc1: { rate: 120, source: "company" } },
      },
    });
    expect(form).toEqual({ mode: "all", all: "120", byStaff: { s1: "130", s2: "120" }, byCostCentre: { none: "120", cc1: "120" } });
  });

  it("names whoever still needs a rate", () => {
    const form = { mode: "technician" as const, all: "", byStaff: { s1: "100" }, byCostCentre: {} };
    expect(rateFormProblem(form, groups)).toBe("Enter an hourly rate for Sam.");
    expect(rateFormProblem({ ...form, byStaff: { s1: "100", s2: "90" } }, groups)).toBeNull();
    expect(rateFormProblem({ ...form, mode: "cost_centre" }, groups)).toBe("Enter an hourly rate for No cost centre.");
    expect(rateFormProblem({ ...form, mode: "all", all: "-5" }, groups)).toMatch(/all hours/);
    expect(rateFormProblem(form, [])).toMatch(/no hours/);
  });

  it("lists each technician and cost centre once", () => {
    expect(rateTargets([...groups, g({ key: "cc1|s1", costCentreKey: "cc1", costCentreName: "Sewer" })])).toEqual({
      staff: [{ id: "s1", name: "Dave" }, { id: "s2", name: "Sam" }],
      costCentres: [{ key: "none", name: "No cost centre" }, { key: "cc1", name: "Sewer" }],
    });
  });
});

describe("applyHourlyRate", () => {
  it("posts the web's body and surfaces the 409 'already in Xero' question with its code", async () => {
    respond(409, { error: "This invoice is already in Xero.", code: "confirm_outside" });
    const form = { mode: "all" as const, all: "120", byStaff: {}, byCostCentre: {} };
    const err = await applyHourlyRate("inv1", form).catch((e) => e);
    expect(err).toBeInstanceOf(OfficeApiError);
    expect(err.code).toBe("confirm_outside");
    expect(err.status).toBe(409);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://app.example/api/invoices/inv1/hours");
    expect(JSON.parse(init.body)).toEqual({ mode: "all", all: "120", byStaff: {}, byCostCentre: {}, confirmOutside: false });
  });

  it("returns the new total once confirmed", async () => {
    respond(200, { ok: true, lines: 2, entries: 3, hours: 6, subtotal: 720, tax: 72, total: 792 });
    const r = await applyHourlyRate("inv1", { mode: "all", all: "120", byStaff: {}, byCostCentre: {} }, true);
    expect(r.total).toBe(792);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).confirmOutside).toBe(true);
  });

  it("says when there is no signal", async () => {
    fetchMock.mockRejectedValueOnce(new Error("Network request failed"));
    await expect(applyHourlyRate("inv1", { mode: "all", all: "1", byStaff: {}, byCostCentre: {} })).rejects.toThrow(/signal/);
  });
});
