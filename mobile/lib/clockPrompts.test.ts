jest.mock("expo-notifications", () => ({}));
jest.mock("@react-native-async-storage/async-storage", () => require("@react-native-async-storage/async-storage/jest/async-storage-mock"));

import {
  CLOCK_ANCHORS_KEY,
  PROMPT_CONTEXT_KEY,
  PROMPT_STATE_KEY,
  answerClockPrompt,
  depotCoords,
  depotLookupDue,
  parsePromptState,
  processClockPrompts,
  publishPromptContext,
  readClockAnchors,
  rememberClockAnchor,
  type ClockPromptIO,
} from "./clockPrompts";
import { DWELL_MS, declineClockOn, EMPTY_PROMPT_STATE, type ClockPrompt, type PlannedNotification, type PromptContext } from "./dwellPrompt";

const T0 = Date.parse("2026-11-23T07:00:00+11:00");
const MIN = 60_000;

function fakeIO(start = T0) {
  const store = new Map<string, string>();
  const scheduled: PlannedNotification[] = [];
  const cancelled: string[] = [];
  let now = start;
  const io: ClockPromptIO = {
    storage: {
      get: async (k) => store.get(k) ?? null,
      set: async (k, v) => void store.set(k, v),
      remove: async (k) => void store.delete(k),
    },
    notifier: {
      schedule: async (n) => void scheduled.push(n),
      cancel: async (id) => void cancelled.push(id),
    },
    now: () => now,
  };
  return { io, store, scheduled, cancelled, setNow: (ms: number) => (now = ms) };
}

const ctx: PromptContext = {
  staffId: "tech-1",
  enabled: true,
  dayKey: "2026-11-23",
  candidates: [{ jobId: "job-a", jobNumber: 123, title: "Sewer", place: "12 Smith St", scheduledCostCenterId: null }],
  openEntries: [],
  pinnedSites: [],
  depot: null,
};
const reading = (atMs: number, lat = -37.65) => ({ coords: { latitude: lat, longitude: 145.03, accuracy: 10 }, timestamp: atMs });

describe("processClockPrompts", () => {
  it("schedules the stay's notification once, then returns the prompt when due", async () => {
    const f = fakeIO();
    await publishPromptContext(ctx, f.io);
    expect(await processClockPrompts([reading(T0)], { staffId: "tech-1" }, f.io)).toBeNull();
    expect(f.scheduled).toEqual([expect.objectContaining({ id: "clock-on", atMs: T0 + DWELL_MS })]);

    f.setNow(T0 + 16 * MIN);
    const p = await processClockPrompts([], { staffId: "tech-1" }, f.io);
    expect(p?.kind).toBe("clock-on");
    // Already scheduled for this stay: not again.
    expect(f.scheduled).toHaveLength(1);
  });

  it("asks nothing with another user's context", async () => {
    const f = fakeIO();
    await publishPromptContext(ctx, f.io);
    f.setNow(T0 + 20 * MIN);
    expect(await processClockPrompts([reading(T0), reading(T0 + 20 * MIN)], { staffId: "someone-else" }, f.io)).toBeNull();
    expect(f.scheduled).toEqual([]);
  });

  it("drops bad readings and survives corrupt storage", async () => {
    const f = fakeIO();
    f.store.set(PROMPT_STATE_KEY, "{not json");
    f.store.set(PROMPT_CONTEXT_KEY, JSON.stringify(ctx));
    await processClockPrompts([{ coords: { latitude: NaN, longitude: 1 }, timestamp: T0 }], { staffId: "tech-1" }, f.io);
    expect(parsePromptState(f.store.get(PROMPT_STATE_KEY) ?? null).dwell).toBeNull();
  });

  it("an answer takes the notification down and isn't asked again", async () => {
    const f = fakeIO();
    await publishPromptContext(ctx, f.io);
    await processClockPrompts([reading(T0)], { staffId: "tech-1" }, f.io);
    f.setNow(T0 + 16 * MIN);
    const p = (await processClockPrompts([], { staffId: "tech-1" }, f.io)) as Extract<ClockPrompt, { kind: "clock-on" }>;
    await answerClockPrompt(p, (s) => declineClockOn(s, p), { staffId: "tech-1" }, f.io);
    expect(f.cancelled).toContain("clock-on");
    expect(await processClockPrompts([reading(T0 + 17 * MIN)], { staffId: "tech-1" }, f.io)).toBeNull();
  });

  it("signing out cancels whatever is scheduled and clears the state", async () => {
    const f = fakeIO();
    await publishPromptContext(ctx, f.io);
    await processClockPrompts([reading(T0)], { staffId: "tech-1" }, f.io);
    await publishPromptContext(null, f.io);
    expect(f.cancelled).toEqual(["clock-on"]);
    expect(f.store.has(PROMPT_STATE_KEY)).toBe(false);
    expect(f.store.has(PROMPT_CONTEXT_KEY)).toBe(false);
  });

  it("forgets an entry the background auto-clock just closed", async () => {
    const f = fakeIO(Date.parse("2026-11-23T17:05:00+11:00"));
    const open = { entryId: "e1", jobId: "job-p", jobNumber: 7, title: "P", clockInIso: new Date(T0).toISOString(), pinned: true, anchor: null };
    await publishPromptContext({ ...ctx, candidates: [], openEntries: [open] }, f.io);
    expect(await processClockPrompts([], { staffId: "tech-1", closedJobIds: ["job-p"] }, f.io)).toBeNull();
    expect((await processClockPrompts([], { staffId: "tech-1" }, f.io))?.kind).toBe("late");
  });
});

describe("clock-on anchors", () => {
  it("remembers where each entry was clocked on, keeping the latest 20", async () => {
    const f = fakeIO();
    for (let i = 0; i < 25; i++) {
      f.setNow(T0 + i);
      await rememberClockAnchor(`e${i}`, { lat: 1, lng: 2, accuracy: 5 }, f.io);
    }
    const anchors = await readClockAnchors(f.io);
    expect(Object.keys(anchors)).toHaveLength(20);
    expect(anchors.e24).toEqual({ lat: 1, lng: 2, accuracy: 5 });
    expect(anchors.e0).toBeUndefined();
    await rememberClockAnchor("none", null, f.io);
    expect(JSON.parse(f.store.get(CLOCK_ANCHORS_KEY)!).none).toBeUndefined();
  });
});

describe("the depot", () => {
  it("is looked up once and cached", async () => {
    const f = fakeIO();
    const lookup = jest.fn(async () => ({ lat: -37.64, lng: 145.02 }));
    expect(await depotCoords(lookup, f.io)).toEqual({ lat: -37.64, lng: 145.02 });
    expect(await depotCoords(lookup, f.io)).toEqual({ lat: -37.64, lng: 145.02 });
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("without signal: no exclusion, and tried again a day later", async () => {
    const f = fakeIO();
    const lookup = jest.fn(async (): Promise<{ lat: number; lng: number } | null> => {
      throw new Error("No connection");
    });
    expect(await depotCoords(lookup, f.io)).toBeNull();
    f.setNow(T0 + 60 * MIN);
    expect(await depotCoords(lookup, f.io)).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(1);
    f.setNow(T0 + 25 * 60 * MIN);
    await depotCoords(lookup, f.io);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("not found: tried again a week later", () => {
    expect(depotLookupDue({ failedAtMs: T0, notFound: true }, T0 + 2 * 24 * 60 * MIN)).toBe(false);
    expect(depotLookupDue({ failedAtMs: T0, notFound: true }, T0 + 8 * 24 * 60 * MIN)).toBe(true);
    expect(depotLookupDue(null, T0)).toBe(true);
    expect(depotLookupDue({ lat: 1, lng: 2 }, T0)).toBe(false);
  });
});

it("an empty state parses to the empty state", () => {
  expect(parsePromptState(null)).toEqual(EMPTY_PROMPT_STATE);
});
