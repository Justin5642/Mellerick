import { todaySteps } from "./todaySteps";

// The Today card's checklist (Stage 6): each step ticks itself off from what
// is already recorded, and the first step still to do is the one it points at.

const fmt = () => "7:02 am";
const states = (s: ReturnType<typeof todaySteps>) => s.map((x) => `${x.key}:${x.state}`);

describe("todaySteps", () => {
  it("points at clocking on when the tech has just arrived", () => {
    expect(states(todaySteps({ clockedInSince: null, orders: [], signedOff: false, formatTime: fmt }))).toEqual([
      "clock:next",
      "materials:optional",
      "deliveries:optional",
      "progress:optional",
      "finish:todo",
    ]);
  });

  it("points at deliveries while an order hasn't turned up", () => {
    const s = todaySteps({
      clockedInSince: "2026-10-31T20:02:00Z",
      orders: [{ status: "ordered" }, { status: "received", deliveredAt: "2026-10-31T22:00:00Z" }],
      signedOff: false,
      formatTime: fmt,
    });
    expect(states(s)).toEqual(["clock:done", "materials:done", "deliveries:next", "progress:optional", "finish:todo"]);
    expect(s[0].detail).toBe("On since 7:02 am");
    expect(s[2].detail).toMatch(/1 waiting/);
    expect(s[4].detail).toMatch(/1 delivery not confirmed/);
  });

  it("points at completing once everything is in", () => {
    const s = todaySteps({ clockedInSince: "x", orders: [{ status: "received" }], signedOff: false, formatTime: fmt });
    expect(s.find((x) => x.state === "next")?.key).toBe("finish");
  });

  it("ignores cancelled orders", () => {
    const s = todaySteps({ clockedInSince: "x", orders: [{ status: "cancelled" }], signedOff: false, formatTime: fmt });
    expect(s[1].state).toBe("optional");
    expect(s[2].detail).toBe("Nothing to deliver");
  });

  it("says when orders couldn't be loaded", () => {
    expect(todaySteps({ clockedInSince: "x", orders: null, signedOff: false, formatTime: fmt })[1].detail).toBe("Orders need signal");
  });

  it("is all done once signed off", () => {
    const s = todaySteps({ clockedInSince: null, orders: [], signedOff: true, formatTime: fmt });
    expect(s.some((x) => x.state === "next" || x.state === "todo")).toBe(false);
  });
});
