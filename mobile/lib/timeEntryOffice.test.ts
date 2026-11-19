import { RATE_CHOICES, canEditEntry, rateOverrideFor } from "./timeEntryOffice";

describe("rateOverrideFor", () => {
  it("sends nothing unless an admin picked a band for a work entry", () => {
    expect(rateOverrideFor("double_time", { isAdmin: false, entryType: "work" })).toBeUndefined();
    expect(rateOverrideFor("double_time", { isAdmin: true, entryType: "travel" })).toBeUndefined();
    expect(rateOverrideFor("keep", { isAdmin: true, entryType: "work" })).toBeUndefined();
  });

  it("maps the admin's choice to the column", () => {
    expect(rateOverrideFor("auto", { isAdmin: true, entryType: "work" })).toBeNull();
    expect(rateOverrideFor("normal", { isAdmin: true, entryType: "work" })).toBe("normal");
    expect(rateOverrideFor("time_and_half", { isAdmin: true, entryType: "work" })).toBe("time_and_half");
    expect(rateOverrideFor("double_time", { isAdmin: true, entryType: "work" })).toBe("double_time");
  });

  it("offers normal, 1.5x and 2x", () => {
    expect(RATE_CHOICES.map((c) => c.label)).toEqual(expect.arrayContaining(["Normal", "1.5×", "2×"]));
  });
});

describe("canEditEntry", () => {
  it("own entries for everyone, anyone's for office/admin", () => {
    expect(canEditEntry({ staff_id: "me" }, "me", false)).toBe(true);
    expect(canEditEntry({ staff_id: "dave" }, "me", false)).toBe(false);
    expect(canEditEntry({ staff_id: "dave" }, "me", true)).toBe(true);
  });
});
