import { carryOutAnswer, type ClockPromptAnswerDeps } from "./clockPromptAnswers";
import { EMPTY_PROMPT_STATE, type ClockPrompt, type PromptFix, type PromptOpenEntry } from "./dwellPrompt";
import { TimeEntryRefused } from "./data/repositories/timeEntries";

const T0 = Date.parse("2026-11-23T07:00:00+11:00");
const MIN = 60_000;
const f = (atMs: number, accuracy: number | null): PromptFix => ({ lat: -37.65, lng: 145.03, accuracy, atMs });

function deps(over: Partial<ClockPromptAnswerDeps> = {}) {
  const d = {
    staffId: "tech-1",
    getOpenWorkEntry: jest.fn(async () => null),
    getOpenWorkEntryOnJob: jest.fn(async () => ({ id: "e1", clockInIso: new Date(T0).toISOString() })),
    getJobCostCentre: jest.fn(async () => "cc-job"),
    clockIn: jest.fn(async () => "new-entry"),
    clockOut: jest.fn(async () => undefined),
    readSitePin: jest.fn(async () => "unpinned" as const),
    postSiteLocation: jest.fn(async () => undefined),
    currentFix: jest.fn(async () => ({ lat: 1, lng: 2, accuracy: 9 })),
    ...over,
  };
  return d as typeof d & ClockPromptAnswerDeps;
}

const clockOn = (best: PromptFix): Extract<ClockPrompt, { kind: "clock-on" }> => ({
  kind: "clock-on",
  id: "clock-on",
  key: `on-${T0}`,
  dueAtMs: T0 + 15 * MIN,
  title: "",
  body: "",
  startFix: f(T0, 30),
  bestFix: best,
  candidates: [
    {
      jobId: "job-a",
      jobNumber: 123,
      title: "Sewer",
      place: null,
      scheduledCostCenterId: null,
      bookings: [{ starts_at: "2026-11-23T07:00:00+11:00", ends_at: "2026-11-23T15:30:00+11:00", daily: false, cost_center_id: "cc-booking" }],
    },
  ],
});

const entry: PromptOpenEntry = { entryId: "e1", jobId: "job-a", jobNumber: 123, title: "Sewer", clockInIso: new Date(T0).toISOString(), pinned: false, anchor: null };

describe("clock-on answers", () => {
  it("Yes clocks on backdated to the stay's start, with its fix and the booking's cost centre, then pins the site", async () => {
    const d = deps();
    const out = await carryOutAnswer(clockOn(f(T0 + 5 * MIN, 12)), { kind: "clock-on", jobId: "job-a" }, d);
    expect(d.clockIn).toHaveBeenCalledWith({
      jobId: "job-a",
      staffId: "tech-1",
      costCenterId: "cc-booking",
      fix: { lat: -37.65, lng: 145.03, accuracy: 30 },
      atIso: new Date(T0).toISOString(),
    });
    expect(d.postSiteLocation).toHaveBeenCalledWith("job-a", { lat: -37.65, lng: 145.03, accuracy: 12 });
    expect(out.message?.body).toMatch(/Clocked on from 7:00 am.*location is saved/);
    expect(out.change(EMPTY_PROMPT_STATE).clockedOnJobs).toEqual(["job-a"]);
  });

  it("clocks on but doesn't pin with a fix worse than ±50 m", async () => {
    const d = deps();
    const out = await carryOutAnswer(clockOn(f(T0, 60)), { kind: "clock-on", jobId: "job-a" }, d);
    expect(d.clockIn).toHaveBeenCalled();
    expect(d.postSiteLocation).not.toHaveBeenCalled();
    expect(out.message?.body).toMatch(/wasn't precise enough/);
  });

  it("never moves an existing pin, and offline clocks on without one", async () => {
    const pinned = deps({ readSitePin: jest.fn(async () => "pinned" as const) });
    await carryOutAnswer(clockOn(f(T0, 10)), { kind: "clock-on", jobId: "job-a" }, pinned);
    expect(pinned.postSiteLocation).not.toHaveBeenCalled();
    const offline = deps({ readSitePin: jest.fn(async () => "unknown" as const) });
    const out = await carryOutAnswer(clockOn(f(T0, 10)), { kind: "clock-on", jobId: "job-a" }, offline);
    expect(offline.clockIn).toHaveBeenCalled();
    expect(offline.postSiteLocation).not.toHaveBeenCalled();
    expect(out.message?.body).toMatch(/needs signal/);
  });

  it("a failed pin still leaves them clocked on", async () => {
    const d = deps({ postSiteLocation: jest.fn(async () => Promise.reject(new Error("No connection."))) });
    const out = await carryOutAnswer(clockOn(f(T0, 10)), { kind: "clock-on", jobId: "job-a" }, d);
    expect(d.clockIn).toHaveBeenCalled();
    expect(out.message?.body).toMatch(/couldn't be saved: No connection/);
  });

  it("does nothing when they're already clocked on", async () => {
    const d = deps({ getOpenWorkEntry: jest.fn(async () => ({ clockInIso: "x" })) });
    const out = await carryOutAnswer(clockOn(f(T0, 10)), { kind: "clock-on", jobId: "job-a" }, d);
    expect(d.clockIn).not.toHaveBeenCalled();
    expect(out.message?.title).toBe("Already clocked on");
  });

  it("falls back to the job's cost centre with no booking", async () => {
    const d = deps();
    const p = clockOn(f(T0, 10));
    p.candidates[0].bookings = [];
    await carryOutAnswer(p, { kind: "clock-on", jobId: "job-a" }, d);
    expect(d.clockIn).toHaveBeenCalledWith(expect.objectContaining({ costCenterId: "cc-job" }));
  });

  it("No records the spot and writes nothing", async () => {
    const d = deps();
    const out = await carryOutAnswer(clockOn(f(T0, 10)), { kind: "decline" }, d);
    expect(d.clockIn).not.toHaveBeenCalled();
    expect(out.change(EMPTY_PROMPT_STATE).declinedSpots).toHaveLength(1);
  });
});

describe("clock-off answers", () => {
  const left: ClockPrompt = {
    kind: "left-site",
    id: "left-e1",
    key: "k",
    dueAtMs: 0,
    title: "",
    body: "",
    entry,
    leftFix: f(Date.parse("2026-11-23T15:42:00+11:00"), 20),
  };

  it("Left the site: Yes clocks off backdated to the first fix outside, with that fix", async () => {
    const d = deps();
    const out = await carryOutAnswer(left, { kind: "clock-off" }, d);
    expect(d.clockOut).toHaveBeenCalledWith({
      entryId: "e1",
      clockInIso: new Date(T0).toISOString(),
      fix: { lat: -37.65, lng: 145.03, accuracy: 20 },
      atIso: "2026-11-23T04:42:00.000Z",
    });
    expect(out.message?.body).toBe("Clocked off at 3:42 pm, when you left the site.");
  });

  it("Still working snoozes; nothing is written", async () => {
    const d = deps();
    const out = await carryOutAnswer(left, { kind: "still-working" }, d);
    expect(d.clockOut).not.toHaveBeenCalled();
    expect(out.change(EMPTY_PROMPT_STATE).left.e1.snoozeUntilMs).not.toBeNull();
  });

  it("an entry closed meanwhile is left alone", async () => {
    const d = deps({ getOpenWorkEntryOnJob: jest.fn(async () => null) });
    const out = await carryOutAnswer(left, { kind: "clock-off" }, d);
    expect(d.clockOut).not.toHaveBeenCalled();
    expect(out.message?.title).toBe("Already clocked off");
  });

  it("a refused close says why", async () => {
    const d = deps({ clockOut: jest.fn(async () => Promise.reject(new TimeEntryRefused("over_24h", new Date(T0).toISOString()))) });
    const out = await carryOutAnswer(left, { kind: "clock-off" }, d);
    expect(out.message?.title).toBe("Couldn't clock off");
  });

  it("Still clocked on: Clock off now — now, not backdated, with the current fix", async () => {
    const d = deps();
    const late: ClockPrompt = { kind: "late", id: "late-e1-17", key: "k", dueAtMs: 0, title: "", body: "", entry, hour: 17 };
    await carryOutAnswer(late, { kind: "clock-off" }, d);
    expect(d.clockOut).toHaveBeenCalledWith({ entryId: "e1", clockInIso: new Date(T0).toISOString(), fix: { lat: 1, lng: 2, accuracy: 9 } });
    const still = await carryOutAnswer(late, { kind: "still-working" }, deps());
    expect(still.change(EMPTY_PROMPT_STATE).late.e1).toEqual([17]);
  });
});
