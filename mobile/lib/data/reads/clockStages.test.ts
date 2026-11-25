const mockIn = jest.fn();
jest.mock("../../supabase", () => ({
  supabase: {
    from: jest.fn(() => ({ select: jest.fn(() => ({ in: mockIn })) })),
  },
}));
const mockOfficeApi = jest.fn();
jest.mock("../../officeApi", () => ({ officeApi: (...a: unknown[]) => mockOfficeApi(...a) }));

import { completedStageIdsByJob, listJobClockStages, withCompletedStages } from "./clockStages";
import { arrivalCostCentre } from "../../geofenceState";

beforeEach(() => {
  mockIn.mockReset();
  mockOfficeApi.mockReset();
});

describe("completed stages for the clock-on (25 Nov 2026)", () => {
  it("a job's stages come from the stages route, ids/names/completion only", async () => {
    mockOfficeApi.mockResolvedValueOnce({ stages: [{ id: "a", name: "Drainage", costCentre: null, completedAt: "2026-11-01T00:00:00Z", poNumber: "1" }] });
    expect(await listJobClockStages("j")).toEqual([{ id: "a", name: "Drainage", costCentre: null, completed_at: "2026-11-01T00:00:00Z" }]);
    expect(mockOfficeApi).toHaveBeenCalledWith("/api/jobs/j/stages");
  });

  it("offline or refused: not known (null), never an error", async () => {
    mockOfficeApi.mockRejectedValueOnce(new Error("No connection"));
    expect(await listJobClockStages("j")).toBeNull();
  });

  it("several jobs' completed stage ids from the money-free view", async () => {
    mockIn.mockResolvedValueOnce({
      data: [
        { job_id: "j1", po_cost_centers_public: [{ id: "a", completed_at: "2026-11-01" }, { id: "b", completed_at: null }] },
        { job_id: "j1", po_cost_centers_public: [{ id: "c", completed_at: "2026-11-02" }] },
        { job_id: "j2", po_cost_centers_public: [] },
      ],
      error: null,
    });
    const map = await completedStageIdsByJob(["j1", "j2"]);
    expect(map?.get("j1")).toEqual(["a", "c"]);
    expect(map?.get("j2")).toEqual([]);
  });

  it("before 0118 (no completed_at on the view): not known, sites unchanged", async () => {
    mockIn.mockResolvedValueOnce({ data: null, error: { code: "42703", message: "column completed_at does not exist" } });
    const sites = [{ jobId: "j1", lat: 0, lng: 0, scheduledCostCenterId: "a" }];
    expect(await withCompletedStages(sites)).toEqual(sites);
  });

  it("an arrival never clocks onto a completed stage", async () => {
    mockIn.mockResolvedValueOnce({ data: [{ job_id: "j1", po_cost_centers_public: [{ id: "a", completed_at: "2026-11-01" }] }], error: null });
    const [site] = await withCompletedStages([{ jobId: "j1", lat: 0, lng: 0, scheduledCostCenterId: "a" }]);
    expect(arrivalCostCentre(site, Date.now())).toBeNull();
    expect(arrivalCostCentre({ ...site, completedCostCentreIds: undefined }, Date.now())).toBe("a");
  });
});
