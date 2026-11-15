jest.mock("./supplierOrders", () => ({ call: jest.fn() }));
import { isMultiDay } from "./jobStages";

// Which jobs open the Sign Off tab on "Finish for today" (4 Nov 2026).
describe("isMultiDay", () => {
  const now = new Date(2026, 10, 4, 15, 0); // Wed 4 Nov, 3 pm local
  const at = (d: number, h = 7) => new Date(2026, 10, d, h).toISOString();

  it("is true for a job booked over days that ends after today", () => {
    expect(isMultiDay({ scheduled_start: at(2), scheduled_end: at(6, 15) }, now)).toBe(true);
  });

  it("is false on its last day, so the last day defaults to Job complete", () => {
    expect(isMultiDay({ scheduled_start: at(2), scheduled_end: at(4, 15) }, now)).toBe(false);
  });

  it("is false for a one-day job and an unscheduled one", () => {
    expect(isMultiDay({ scheduled_start: at(4), scheduled_end: at(4, 15) }, now)).toBe(false);
    expect(isMultiDay({ scheduled_start: null, scheduled_end: null }, now)).toBe(false);
  });
});
