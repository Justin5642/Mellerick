import { skipAutoClockOn } from "./autoClockClosedJob";

const at = "2026-11-27T01:54:00.000Z"; // 12:54 Melbourne

describe("skipAutoClockOn", () => {
  it("clocks on to an open job", () => {
    expect(skipAutoClockOn({ status: "in_progress", actualEnd: null }, at)).toBe(false);
    expect(skipAutoClockOn({ status: "scheduled", actualEnd: null }, at)).toBe(false);
  });

  it("clocks on when the status couldn't be read", () => {
    expect(skipAutoClockOn(null, at)).toBe(false);
    expect(skipAutoClockOn({ status: null, actualEnd: null }, at)).toBe(false);
  });

  it("skips a job signed off before the clock-on (the Templestowe case)", () => {
    expect(skipAutoClockOn({ status: "completed", actualEnd: "2026-11-27T01:50:00.000Z" }, at)).toBe(true);
  });

  it("skips a completed or cancelled job with no end time", () => {
    expect(skipAutoClockOn({ status: "completed", actualEnd: null }, at)).toBe(true);
    expect(skipAutoClockOn({ status: "cancelled", actualEnd: null }, at)).toBe(true);
  });

  it("keeps a clock-on from before sign-off that only synced later", () => {
    expect(skipAutoClockOn({ status: "completed", actualEnd: "2026-11-27T03:00:00.000Z" }, at)).toBe(false);
  });

  it("skips when the end time can't be read", () => {
    expect(skipAutoClockOn({ status: "completed", actualEnd: "not a date" }, at)).toBe(true);
  });
});
