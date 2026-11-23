import {
  DWELL_MS,
  EMPTY_PROMPT_STATE,
  LEFT_SITE_MS,
  MAX_DWELL_MS,
  MAX_SILENT_MS,
  STILL_WORKING_SNOOZE_MS,
  acceptClockOn,
  advanceDwell,
  answerLate,
  applyFixes,
  bookedOnDay,
  businessHourMs,
  clockOnText,
  clockPrompts,
  declineClockOn,
  duePrompt,
  isDue,
  leftSiteText,
  planNotifications,
  promptCostCentre,
  promptSiteCount,
  snoozeLeftSite,
  stayedMs,
  unpinnedJobsToday,
  usableFix,
  withoutClosedJobs,
  type ClockPrompt,
  type JobForPrompt,
  type PromptContext,
  type PromptFix,
  type PromptOpenEntry,
  type PromptState,
} from "./dwellPrompt";

// 23 Nov 2026 is AEDT (UTC+11): 07:00 Melbourne = 20:00Z the day before.
const DAY = "2026-11-23";
const T0 = Date.parse("2026-11-23T07:00:00+11:00");
const MIN = 60_000;
// A spot in Epping and points ~N metres north of it (1e-5 deg lat ≈ 1.11 m).
const SPOT = { lat: -37.65, lng: 145.03 };
const north = (m: number) => ({ lat: SPOT.lat + m / 111_195, lng: SPOT.lng });

function fix(atMs: number, at: { lat: number; lng: number } = SPOT, accuracy: number | null = 10): PromptFix {
  return { ...at, accuracy, atMs };
}

function ctx(over: Partial<PromptContext> = {}): PromptContext {
  return {
    staffId: "tech-1",
    enabled: true,
    dayKey: DAY,
    candidates: [{ jobId: "job-a", jobNumber: 123, title: "Sewer", place: "12 Smith St, Craigieburn", scheduledCostCenterId: "cc-job" }],
    openEntries: [],
    pinnedSites: [],
    depot: null,
    ...over,
  };
}

function stay(minutes: number, start = T0, at = SPOT): PromptState {
  return applyFixes(EMPTY_PROMPT_STATE, ctx(), [fix(start, at), fix(start + minutes * MIN, at)], DAY);
}

describe("usableFix", () => {
  it("drops readings worse than ±75 m, bad coordinates and bad times", () => {
    expect(usableFix({ coords: { latitude: 1, longitude: 2, accuracy: 76 }, timestamp: 1 })).toBeNull();
    expect(usableFix({ coords: { latitude: NaN, longitude: 2, accuracy: 5 }, timestamp: 1 })).toBeNull();
    expect(usableFix({ coords: { latitude: 1, longitude: 2, accuracy: 5 }, timestamp: NaN })).toBeNull();
    expect(usableFix({ coords: { latitude: 1, longitude: 2, accuracy: 75 }, timestamp: 1 })).toEqual({ lat: 1, lng: 2, accuracy: 75, atMs: 1 });
    expect(usableFix({ coords: { latitude: 1, longitude: 2 }, timestamp: 1 })?.accuracy).toBeNull();
  });
});

describe("advanceDwell", () => {
  it("keeps a stay within 100 m and remembers the most accurate fix", () => {
    let d = advanceDwell(null, fix(T0, SPOT, 30));
    d = advanceDwell(d, fix(T0 + 5 * MIN, north(60), 8));
    d = advanceDwell(d, fix(T0 + 9 * MIN, north(90), 20));
    expect(d.start.atMs).toBe(T0);
    expect(d.lastFixMs).toBe(T0 + 9 * MIN);
    expect(d.best.accuracy).toBe(8);
  });

  it("restarts when a fix is clearly elsewhere", () => {
    const d = advanceDwell(advanceDwell(null, fix(T0)), fix(T0 + 5 * MIN, north(200), 10));
    expect(d.start.atMs).toBe(T0 + 5 * MIN);
  });

  it("allows some of a fix's own accuracy (up to 50 m) before calling it a move", () => {
    const d = advanceDwell(advanceDwell(null, fix(T0)), fix(T0 + MIN, north(140), 60));
    expect(d.start.atMs).toBe(T0);
    const d2 = advanceDwell(advanceDwell(null, fix(T0)), fix(T0 + MIN, north(160), 60));
    expect(d2.start.atMs).toBe(T0 + MIN);
  });

  it("restarts when the clock moved backwards", () => {
    const d = advanceDwell(advanceDwell(null, fix(T0)), fix(T0 + 10 * MIN));
    expect(advanceDwell(d, fix(T0 - 30 * MIN)).start.atMs).toBe(T0 - 30 * MIN);
  });

  it("restarts a stay too long to be one", () => {
    const d = advanceDwell(null, fix(T0));
    expect(advanceDwell(d, fix(T0 + MAX_DWELL_MS + MIN)).start.atMs).toBe(T0 + MAX_DWELL_MS + MIN);
  });
});

describe("stayedMs", () => {
  const d = advanceDwell(null, fix(T0));
  it("counts a parked phone's silence up to now", () => {
    expect(stayedMs(d, T0 + 16 * MIN)).toBe(16 * MIN);
  });
  it("never counts a clock that went back before the last fix", () => {
    expect(stayedMs(d, T0 - 60 * MIN)).toBe(0);
  });
  it("stops counting once the trail goes cold", () => {
    expect(stayedMs(d, T0 + MAX_SILENT_MS + MIN)).toBe(0);
  });
});

describe("today's unpinned jobs", () => {
  const job = (over: Partial<JobForPrompt>): JobForPrompt => ({
    id: "j",
    job_number: 1,
    title: "T",
    status: "scheduled",
    scheduled_start: "2026-11-23T07:00:00+11:00",
    scheduled_end: "2026-11-23T15:30:00+11:00",
    schedule_daily: false,
    sites: { name: "Lot 4", address_line1: "12 Smith St", suburb: "Craigieburn", site_lat: null, site_lng: null },
    ...over,
  });

  it("keeps an open, unpinned job booked today", () => {
    const [c] = unpinnedJobsToday([job({})], DAY);
    expect(c).toMatchObject({ jobId: "j", jobNumber: 1, place: "12 Smith St, Craigieburn" });
  });

  it("drops pinned, site-less, closed and not-today jobs", () => {
    expect(unpinnedJobsToday([job({ sites: { site_lat: -37.6, site_lng: 145 } })], DAY)).toHaveLength(0);
    expect(unpinnedJobsToday([job({ sites: null })], DAY)).toHaveLength(0);
    expect(unpinnedJobsToday([job({ status: "completed" })], DAY)).toHaveLength(0);
    expect(unpinnedJobsToday([job({ scheduled_start: "2026-11-24T07:00:00+11:00", scheduled_end: "2026-11-24T15:30:00+11:00" })], DAY)).toHaveLength(0);
  });

  it("treats a 0/0 pin as no pin", () => {
    expect(unpinnedJobsToday([job({ sites: { site_lat: 0, site_lng: 0, address_line1: "x" } })], DAY)).toHaveLength(1);
  });

  it("uses the technician's own bookings, by the multi-day rules, not scheduled_start", () => {
    // A Mon–Wed daily job: the job window STARTS on Monday 23rd...
    const monWed = { scheduled_start: "2026-11-23T07:00:00+11:00", scheduled_end: "2026-11-25T15:30:00+11:00", schedule_daily: true };
    expect(bookedOnDay(monWed, "2026-11-24")).toBe(true);
    // ...but this technician is booked only on the Wednesday.
    const bookings = [{ starts_at: "2026-11-25T07:00:00+11:00", ends_at: "2026-11-25T15:30:00+11:00", daily: false, cost_center_id: "cc-1" }];
    expect(bookedOnDay({ ...monWed, bookings }, DAY)).toBe(false);
    expect(bookedOnDay({ ...monWed, bookings }, "2026-11-25")).toBe(true);
  });

  it("picks the booking's cost centre at the backdated time, else the job's", () => {
    const bookings = [{ starts_at: "2026-11-23T07:00:00+11:00", ends_at: "2026-11-23T15:30:00+11:00", daily: false, cost_center_id: "cc-b" }];
    const c = { jobId: "j", jobNumber: 1, title: "T", place: null, scheduledCostCenterId: "cc-job" };
    expect(promptCostCentre({ ...c, bookings }, T0)).toBe("cc-b");
    expect(promptCostCentre(c, T0)).toBe("cc-job");
  });
});

describe("the clock-on prompt", () => {
  it("is due after 15 minutes in one spot, backdated to the stay's first fix", () => {
    const s = stay(15);
    const p = duePrompt(s, ctx(), T0 + 15 * MIN, DAY);
    expect(p?.kind).toBe("clock-on");
    expect(p && p.kind === "clock-on" && p.startFix.atMs).toBe(T0);
    expect(p?.body).toBe("Stopped here for 15 min — are you at #123 12 Smith St, Craigieburn? Tap to clock on.");
  });

  it("is not due before 15 minutes", () => {
    expect(duePrompt(stay(10), ctx(), T0 + 10 * MIN, DAY)).toBeNull();
  });

  it("lists every candidate when there are several", () => {
    const two = ctx({
      candidates: [
        { jobId: "a", jobNumber: 1, title: "A", place: null, scheduledCostCenterId: null },
        { jobId: "b", jobNumber: 2, title: "B", place: null, scheduledCostCenterId: null },
      ],
    });
    const p = duePrompt(stay(20), two, T0 + 20 * MIN, DAY);
    expect(p && p.kind === "clock-on" && p.candidates.map((c) => c.jobId)).toEqual(["a", "b"]);
    expect(clockOnText(two.candidates).body).toContain("(#1, #2)");
  });

  it("is never asked while clocked on, with no candidates, or switched off", () => {
    const open: PromptOpenEntry = { entryId: "e", jobId: "x", jobNumber: 9, title: "X", clockInIso: new Date(T0).toISOString(), pinned: true, anchor: null };
    expect(duePrompt(stay(20), ctx({ openEntries: [open] }), T0 + 20 * MIN, DAY)?.kind).not.toBe("clock-on");
    expect(duePrompt(stay(20), ctx({ candidates: [] }), T0 + 20 * MIN, DAY)).toBeNull();
    expect(duePrompt(stay(20), ctx({ enabled: false }), T0 + 20 * MIN, DAY)).toBeNull();
  });

  it("ignores a context built for another day", () => {
    expect(duePrompt(stay(20), ctx({ dayKey: "2026-11-22" }), T0 + 20 * MIN, DAY)).toBeNull();
  });

  it("is not asked inside a pinned site's exit fence (the auto-clock handles it)", () => {
    expect(duePrompt(stay(20), ctx({ pinnedSites: [north(240)] }), T0 + 20 * MIN, DAY)).toBeNull();
    expect(duePrompt(stay(20), ctx({ pinnedSites: [north(260)] }), T0 + 20 * MIN, DAY)).not.toBeNull();
    // A site's own bigger fence counts.
    expect(duePrompt(stay(20), ctx({ pinnedSites: [{ ...north(400), radiusM: 320 }] }), T0 + 20 * MIN, DAY)).toBeNull();
  });

  it("is not asked within 300 m of the depot", () => {
    expect(duePrompt(stay(20), ctx({ depot: north(290) }), T0 + 20 * MIN, DAY)).toBeNull();
    expect(duePrompt(stay(20), ctx({ depot: north(320) }), T0 + 20 * MIN, DAY)).not.toBeNull();
  });

  it("after a No, not again within 200 m of that spot today; elsewhere it still asks", () => {
    const s = stay(20);
    const p = duePrompt(s, ctx(), T0 + 20 * MIN, DAY) as Extract<ClockPrompt, { kind: "clock-on" }>;
    const declined = declineClockOn(s, p);
    const nearby = applyFixes(declined, ctx(), [fix(T0 + 60 * MIN, north(150)), fix(T0 + 80 * MIN, north(150))], DAY);
    expect(duePrompt(nearby, ctx(), T0 + 80 * MIN, DAY)).toBeNull();
    const far = applyFixes(declined, ctx(), [fix(T0 + 60 * MIN, north(2000)), fix(T0 + 80 * MIN, north(2000))], DAY);
    expect(duePrompt(far, ctx(), T0 + 80 * MIN, DAY)?.kind).toBe("clock-on");
  });

  it("stops offering a job declined at two spots, and the day resets it", () => {
    let s = stay(20);
    const p = () => duePrompt(s, ctx(), T0 + 400 * MIN, DAY) as Extract<ClockPrompt, { kind: "clock-on" }>;
    s = declineClockOn(s, p());
    s = applyFixes(s, ctx(), [fix(T0 + 300 * MIN, north(3000)), fix(T0 + 320 * MIN, north(3000))], DAY);
    s = declineClockOn(s, p());
    s = applyFixes(s, ctx(), [fix(T0 + 380 * MIN, north(6000)), fix(T0 + 400 * MIN, north(6000))], DAY);
    expect(duePrompt(s, ctx(), T0 + 400 * MIN, DAY)).toBeNull();
    const tomorrow = "2026-11-24";
    const next = applyFixes(s, ctx({ dayKey: tomorrow }), [fix(T0 + 24 * 60 * MIN), fix(T0 + 24 * 60 * MIN + 20 * MIN)], tomorrow);
    expect(duePrompt(next, ctx({ dayKey: tomorrow }), T0 + 24 * 60 * MIN + 20 * MIN, tomorrow)?.kind).toBe("clock-on");
  });

  it("asks once per job per day after a Yes", () => {
    const s = acceptClockOn(stay(20), "job-a");
    const again = applyFixes(s, ctx(), [fix(T0 + 60 * MIN, north(5000)), fix(T0 + 80 * MIN, north(5000))], DAY);
    expect(duePrompt(again, ctx(), T0 + 80 * MIN, DAY)).toBeNull();
  });

  it("is not due when the device clock jumped back before the stay", () => {
    const s = applyFixes(EMPTY_PROMPT_STATE, ctx(), [fix(T0)], DAY);
    expect(duePrompt(s, ctx(), T0 - 60 * MIN, DAY)).toBeNull();
  });
});

describe("the left-the-site prompt", () => {
  const entry: PromptOpenEntry = {
    entryId: "e1",
    jobId: "job-a",
    jobNumber: 123,
    title: "Sewer",
    clockInIso: new Date(T0).toISOString(),
    pinned: false,
    anchor: { lat: SPOT.lat, lng: SPOT.lng, accuracy: 10 },
  };
  const c = ctx({ candidates: [], openEntries: [entry] });
  const away = (startMin: number, endMin: number, m = 400) =>
    applyFixes(EMPTY_PROMPT_STATE, c, [fix(T0 + startMin * MIN, north(m)), fix(T0 + endMin * MIN, north(m))], DAY);

  it("asks after 10 minutes well away, backdated to the first fix outside", () => {
    const s = away(60, 70);
    const p = duePrompt(s, c, T0 + 70 * MIN, DAY);
    expect(p?.kind).toBe("left-site");
    expect(p && p.kind === "left-site" && p.leftFix.atMs).toBe(T0 + 60 * MIN);
    expect(duePrompt(away(60, 65), c, T0 + 65 * MIN, DAY)).toBeNull();
  });

  it("allows for the fix's accuracy before calling it outside", () => {
    // 300 m away but ±60 m: could be 240 m — not definitely outside 250 m.
    const s = applyFixes(EMPTY_PROMPT_STATE, c, [fix(T0, north(300), 60), fix(T0 + 20 * MIN, north(300), 60)], DAY);
    expect(duePrompt(s, c, T0 + 20 * MIN, DAY)).toBeNull();
  });

  it("forgets the absence when they come back", () => {
    const s = applyFixes(away(60, 65), c, [fix(T0 + 66 * MIN, north(50))], DAY);
    expect(duePrompt(s, c, T0 + 80 * MIN, DAY)).toBeNull();
  });

  it("isn't asked for a pinned site (the geofence clocks it off) or with no clock-on spot", () => {
    const pinned = ctx({ candidates: [], openEntries: [{ ...entry, pinned: true }] });
    expect(clockPrompts(away(60, 75), pinned, T0 + 75 * MIN, DAY).some((p) => p.kind === "left-site")).toBe(false);
    const noAnchor = ctx({ candidates: [], openEntries: [{ ...entry, anchor: null }] });
    expect(clockPrompts(away(60, 75), noAnchor, T0 + 75 * MIN, DAY).some((p) => p.kind === "left-site")).toBe(false);
  });

  it("'Still working' waits 60 minutes and a fresh absence", () => {
    const now = T0 + 75 * MIN;
    const snoozed = snoozeLeftSite(away(60, 75), "e1", now);
    expect(duePrompt(snoozed, c, now, DAY)).toBeNull();
    const later = applyFixes(snoozed, c, [fix(now + 30 * MIN, north(400)), fix(now + 45 * MIN, north(400))], DAY);
    expect(duePrompt(later, c, now + 45 * MIN, DAY)).toBeNull(); // still inside the snooze
    const after = applyFixes(later, c, [fix(now + STILL_WORKING_SNOOZE_MS + MIN, north(400))], DAY);
    expect(duePrompt(after, c, now + STILL_WORKING_SNOOZE_MS + MIN, DAY)?.kind).toBe("left-site");
  });

  it("restarts the absence when the clock moves back", () => {
    const s = applyFixes(away(60, 65), c, [fix(T0 + 10 * MIN, north(400))], DAY);
    expect(s.left.e1.firstOutside?.atMs).toBe(T0 + 10 * MIN);
    expect(duePrompt(s, c, T0 + 15 * MIN, DAY)).toBeNull();
  });

  it("drops an entry the background auto-clock just closed", () => {
    expect(withoutClosedJobs(c, ["job-a"])?.openEntries).toEqual([]);
  });

  it("says when", () => {
    expect(leftSiteText(entry, Date.parse("2026-11-23T15:42:00+11:00")).body).toBe("Left #123 at 3:42 pm — clock off at 3:42?");
    expect(LEFT_SITE_MS).toBe(10 * MIN);
  });
});

describe("the still-on-the-clock prompt", () => {
  const entry = (clockIn: string): PromptOpenEntry => ({
    entryId: "e1",
    jobId: "job-a",
    jobNumber: 123,
    title: "Sewer",
    clockInIso: clockIn,
    pinned: true,
    anchor: null,
  });
  const at = (hhmm: string) => Date.parse(`2026-11-23T${hhmm}:00+11:00`);

  it("asks at 17:00 Melbourne, then once more at 19:00", () => {
    const c = ctx({ candidates: [], openEntries: [entry("2026-11-23T07:00:00+11:00")] });
    const s = applyFixes(EMPTY_PROMPT_STATE, c, [], DAY);
    expect(duePrompt(s, c, at("16:59"), DAY)).toBeNull();
    const p17 = duePrompt(s, c, at("17:00"), DAY);
    expect(p17).toMatchObject({ kind: "late", hour: 17, body: "Still clocked on to #123 — clock off now?" });
    const answered = answerLate(s, "e1", 17);
    expect(duePrompt(answered, c, at("18:30"), DAY)).toBeNull();
    expect(duePrompt(answered, c, at("19:00"), DAY)).toMatchObject({ kind: "late", hour: 19 });
    expect(duePrompt(answerLate(answered, "e1", 19), c, at("21:00"), DAY)).toBeNull();
  });

  it("asks the 19:00 one only, not both, once 19:00 has passed unanswered", () => {
    const c = ctx({ candidates: [], openEntries: [entry("2026-11-23T07:00:00+11:00")] });
    expect(duePrompt(EMPTY_PROMPT_STATE, c, at("19:30"), DAY)).toMatchObject({ hour: 19 });
  });

  it("doesn't ask about an entry opened after the hour", () => {
    const c = ctx({ candidates: [], openEntries: [entry("2026-11-23T17:30:00+11:00")] });
    expect(duePrompt(EMPTY_PROMPT_STATE, c, at("18:00"), DAY)).toBeNull();
    expect(duePrompt(EMPTY_PROMPT_STATE, c, at("19:05"), DAY)).toMatchObject({ hour: 19 });
  });

  it("asks nothing when the device clock reads before the clock-on", () => {
    const c = ctx({ candidates: [], openEntries: [entry("2026-11-23T18:00:00+11:00")] });
    const [p] = clockPrompts(EMPTY_PROMPT_STATE, c, at("19:00"), DAY);
    expect(isDue(p, EMPTY_PROMPT_STATE, at("17:59"))).toBe(false);
  });

  it("uses Melbourne hours", () => {
    expect(new Date(businessHourMs(DAY, 17)).toISOString()).toBe("2026-11-23T06:00:00.000Z");
  });
});

describe("planNotifications", () => {
  it("schedules a stay's prompt ahead, once, and cancels it when the stay breaks", () => {
    let s = applyFixes(EMPTY_PROMPT_STATE, ctx(), [fix(T0)], DAY);
    let plan = planNotifications(s, clockPrompts(s, ctx(), T0, DAY), T0);
    expect(plan.schedule).toEqual([expect.objectContaining({ id: "clock-on", atMs: T0 + DWELL_MS })]);
    s = { ...s, scheduled: plan.scheduled };

    // Same stay: nothing new.
    s = applyFixes(s, ctx(), [fix(T0 + 5 * MIN)], DAY);
    plan = planNotifications(s, clockPrompts(s, ctx(), T0 + 5 * MIN, DAY), T0 + 5 * MIN);
    expect(plan.schedule).toEqual([]);
    expect(plan.cancel).toEqual([]);
    s = { ...s, scheduled: plan.scheduled };

    // Moved on: cancelled, and a new stay scheduled.
    s = applyFixes(s, ctx(), [fix(T0 + 8 * MIN, north(1000))], DAY);
    plan = planNotifications(s, clockPrompts(s, ctx(), T0 + 8 * MIN, DAY), T0 + 8 * MIN);
    expect(plan.cancel).toEqual(["clock-on"]);
    expect(plan.schedule).toEqual([expect.objectContaining({ id: "clock-on", atMs: T0 + 8 * MIN + DWELL_MS })]);
  });

  it("shows a due prompt now, and only the latest late hour", () => {
    const e: PromptOpenEntry = { entryId: "e1", jobId: "j", jobNumber: 1, title: "T", clockInIso: new Date(T0).toISOString(), pinned: true, anchor: null };
    const c = ctx({ candidates: [], openEntries: [e] });
    const now = Date.parse("2026-11-23T19:10:00+11:00");
    const plan = planNotifications(EMPTY_PROMPT_STATE, clockPrompts(EMPTY_PROMPT_STATE, c, now, DAY), now);
    expect(plan.schedule.map((n) => [n.id, n.atMs])).toEqual([["late-e1-19", null]]);
  });

  it("schedules both late hours ahead in the morning", () => {
    const e: PromptOpenEntry = { entryId: "e1", jobId: "j", jobNumber: 1, title: "T", clockInIso: new Date(T0).toISOString(), pinned: true, anchor: null };
    const c = ctx({ candidates: [], openEntries: [e] });
    const plan = planNotifications(EMPTY_PROMPT_STATE, clockPrompts(EMPTY_PROMPT_STATE, c, T0 + MIN, DAY), T0 + MIN);
    expect(plan.schedule.map((n) => n.id).sort()).toEqual(["late-e1-17", "late-e1-19"]);
  });
});

describe("promptSiteCount", () => {
  it("counts today's candidates and open unpinned entries with a spot", () => {
    const e: PromptOpenEntry = { entryId: "e1", jobId: "j", jobNumber: 1, title: "T", clockInIso: "x", pinned: false, anchor: { lat: 1, lng: 1, accuracy: 5 } };
    expect(promptSiteCount(ctx({ openEntries: [e] }), DAY)).toBe(2);
    expect(promptSiteCount(ctx({ dayKey: "2026-11-22" }), DAY)).toBe(0);
    expect(promptSiteCount(ctx({ enabled: false }), DAY)).toBe(0);
    expect(promptSiteCount(null, DAY)).toBe(0);
  });
});
