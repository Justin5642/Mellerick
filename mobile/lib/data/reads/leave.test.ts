// The phone's leave read (schedule_leave(), migration 0112 — a draft, not
// applied yet): rows come through as the server sent them (a withheld type
// stays null — "Unavailable"), and anything short of an answer shows no
// leave rather than an error.
const mockRpc = jest.fn();
jest.mock("../../supabase", () => ({ supabase: { rpc: (...args: unknown[]) => mockRpc(...args) } }));

import { listScheduleLeave } from "./leave";

beforeEach(() => {
  mockRpc.mockReset();
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

describe("listScheduleLeave", () => {
  it("asks schedule_leave for the range and maps the rows", async () => {
    mockRpc.mockResolvedValue({
      data: [{ id: null, staff_id: "dave", start_date: "2026-11-18", end_date: "2026-11-18", hours: "3.50", start_time: "12:00:00", end_time: "15:30:00", leave_type: null }],
      error: null,
    });
    const res = await listScheduleLeave("2026-11-01", "2026-11-30");
    expect(mockRpc).toHaveBeenCalledWith("schedule_leave", { p_from: "2026-11-01", p_to: "2026-11-30" });
    expect(res).toEqual({
      available: true,
      leave: [{ id: null, staff_id: "dave", start_date: "2026-11-18", end_date: "2026-11-18", hours: 3.5, start_time: "12:00:00", end_time: "15:30:00", leave_type: null }],
    });
  });

  it("shows no leave before 0112 is applied (function missing)", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Could not find the function" } });
    expect(await listScheduleLeave("2026-11-01", "2026-11-30")).toEqual({ leave: [], available: false });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("shows no leave offline, and says it wasn't read", async () => {
    mockRpc.mockRejectedValue(new TypeError("Network request failed"));
    expect(await listScheduleLeave("2026-11-01", "2026-11-30")).toEqual({ leave: [], available: false });
  });
});
