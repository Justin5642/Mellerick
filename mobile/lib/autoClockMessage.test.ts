jest.mock("./location-tracking", () => ({}));
import { autoClockMessage } from "./autoClockMessage";

const base = { enabled: false, reason: null, backgroundOff: false, approximate: false } as const;

describe("autoClockMessage", () => {
  it("says it's on", () => {
    expect(autoClockMessage({ ...base, enabled: true })).toMatchObject({ tone: "ok", settings: false });
  });

  it("warns about Approximate location before anything else", () => {
    expect(autoClockMessage({ ...base, enabled: true, approximate: true, backgroundOff: true })?.text).toMatch(/Approximate/);
  });

  it("warns when it only works with the app open", () => {
    expect(autoClockMessage({ ...base, enabled: true, backgroundOff: true })).toMatchObject({ tone: "warn", settings: true });
  });

  it("explains why it's off", () => {
    expect(autoClockMessage({ ...base, reason: "declined" })?.settings).toBe(true);
    expect(autoClockMessage({ ...base, reason: "no-sites" })?.text).toMatch(/Set site location here/);
  });

  it("says nothing for office staff", () => {
    expect(autoClockMessage({ ...base, reason: "not-technician" })).toBeNull();
  });
});
