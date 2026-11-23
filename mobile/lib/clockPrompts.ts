import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import {
  EMPTY_PROMPT_STATE,
  applyFixes,
  clockPrompts,
  duePrompt,
  planNotifications,
  todayKey,
  usableFix,
  withoutClosedJobs,
  type ClockPrompt,
  type PlannedNotification,
  type PromptContext,
  type PromptState,
} from "./dwellPrompt";
import type { ClockFix } from "./clockFix";

// The storage and notification half of the clock prompts (lib/dwellPrompt.ts
// holds every rule). Used by both the foreground watcher
// (lib/location-tracking.tsx) and the background location task
// (lib/backgroundClockTask.ts): the state lives in AsyncStorage, so a JS
// context the OS kills between deliveries loses nothing.
//
// Never clocks anyone on or off. It only works out the question and puts a
// notification up; the answer is given in the app (components/ClockPromptSheet).

export const PROMPT_STATE_KEY = "mellerick.clockPrompts.state.v1";
export const PROMPT_CONTEXT_KEY = "mellerick.clockPrompts.context.v1";
export const CLOCK_ANCHORS_KEY = "mellerick.clockPrompts.anchors.v1";
export const DEPOT_KEY = "mellerick.clockPrompts.depot.v1";
/** Notification data marking a clock prompt (lib/push/expoPushGateway.ts hides it while the app is open). */
export const CLOCK_PROMPT_NOTIFICATION_TYPE = "clock_prompt";
const NOTIFICATION_PREFIX = "mellerick-clock-";

export interface PromptStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface PromptNotifier {
  schedule(n: PlannedNotification): Promise<void>;
  cancel(id: string): Promise<void>;
}

export interface ClockPromptIO {
  storage: PromptStorage;
  notifier: PromptNotifier;
  now(): number;
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** A stored state, or the empty one (a corrupt value is a fresh start, never a prompt). */
export function parsePromptState(raw: string | null): PromptState {
  const s = parseJson<Partial<PromptState>>(raw);
  if (!s || typeof s !== "object") return EMPTY_PROMPT_STATE;
  return {
    dayKey: typeof s.dayKey === "string" ? s.dayKey : null,
    dwell: s.dwell && typeof s.dwell === "object" && s.dwell.start ? s.dwell : null,
    declinedSpots: Array.isArray(s.declinedSpots) ? s.declinedSpots : [],
    declines: s.declines && typeof s.declines === "object" ? s.declines : {},
    clockedOnJobs: Array.isArray(s.clockedOnJobs) ? s.clockedOnJobs : [],
    left: s.left && typeof s.left === "object" ? s.left : {},
    late: s.late && typeof s.late === "object" ? s.late : {},
    scheduled: s.scheduled && typeof s.scheduled === "object" ? s.scheduled : {},
  };
}

/** A stored context, or null when absent or malformed. */
export function parsePromptContext(raw: string | null): PromptContext | null {
  const c = parseJson<PromptContext>(raw);
  if (!c || typeof c.staffId !== "string" || typeof c.dayKey !== "string") return null;
  if (!Array.isArray(c.candidates) || !Array.isArray(c.openEntries) || !Array.isArray(c.pinnedSites)) return null;
  return c;
}

// Serialised: the foreground and the background task can both be handed fixes
// in one JS context, and two read-modify-writes of the state would lose one.
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

async function syncNotifications(io: ClockPromptIO, state: PromptState, prompts: ClockPrompt[], nowMs: number): Promise<PromptState> {
  const plan = planNotifications(state, prompts, nowMs);
  for (const id of plan.cancel) await io.notifier.cancel(id).catch(() => undefined);
  const scheduled = { ...plan.scheduled };
  for (const n of plan.schedule) {
    try {
      await io.notifier.schedule(n);
    } catch (e) {
      // Not scheduled: forget it so the next pass tries again.
      delete scheduled[n.id];
      console.warn("[clockPrompts] could not schedule a notification:", e);
    }
  }
  return { ...state, scheduled };
}

/**
 * Feed readings in (any order, any quality — bad ones are dropped), bring the
 * notifications up to date, and return the question due now, if any.
 *
 * `staffId` must be the context's: a context left by another user asks nothing.
 * `closedJobIds`: jobs the background auto-clock has just clocked off.
 */
export async function processClockPrompts(
  readings: { coords: { latitude: number; longitude: number; accuracy?: number | null }; timestamp: number }[],
  opts: { staffId: string | null; closedJobIds?: string[] },
  io: ClockPromptIO = realIO
): Promise<ClockPrompt | null> {
  return serial(async () => {
    const nowMs = io.now();
    const day = todayKey(nowMs);
    const stored = parsePromptContext(await io.storage.get(PROMPT_CONTEXT_KEY));
    const ctx = withoutClosedJobs(stored && stored.staffId === opts.staffId ? stored : null, opts.closedJobIds ?? []);
    const before = parsePromptState(await io.storage.get(PROMPT_STATE_KEY));
    const fixes = readings.map(usableFix).filter((f): f is NonNullable<typeof f> => !!f);
    let state = applyFixes(before, ctx, fixes, day);
    state = await syncNotifications(io, state, clockPrompts(state, ctx, nowMs, day), nowMs);
    await io.storage.set(PROMPT_STATE_KEY, JSON.stringify(state));
    return duePrompt(state, ctx, nowMs, day);
  });
}

/**
 * Record an answer: `change` updates the state (dwellPrompt's acceptClockOn,
 * declineClockOn, snoozeLeftSite, answerLate), the answered notification is
 * taken down, and the rest are brought up to date.
 */
export async function answerClockPrompt(
  prompt: ClockPrompt,
  change: (s: PromptState) => PromptState,
  opts: { staffId: string | null },
  io: ClockPromptIO = realIO
): Promise<void> {
  await serial(async () => {
    const nowMs = io.now();
    const day = todayKey(nowMs);
    const stored = parsePromptContext(await io.storage.get(PROMPT_CONTEXT_KEY));
    const ctx = stored && stored.staffId === opts.staffId ? stored : null;
    let state = change(applyFixes(parsePromptState(await io.storage.get(PROMPT_STATE_KEY)), ctx, [], day));
    await io.notifier.cancel(prompt.id).catch(() => undefined);
    const { [prompt.id]: _answered, ...rest } = state.scheduled;
    void _answered;
    state = { ...state, scheduled: rest };
    state = await syncNotifications(io, state, clockPrompts(state, ctx, nowMs, day), nowMs);
    // The answered question itself must not come straight back as "new".
    if (!(prompt.id in state.scheduled) && clockPrompts(state, ctx, nowMs, day).some((p) => p.id === prompt.id && p.key === prompt.key)) {
      state = { ...state, scheduled: { ...state.scheduled, [prompt.id]: prompt.key } };
    }
    await io.storage.set(PROMPT_STATE_KEY, JSON.stringify(state));
  });
}

/** Hand the day's context to the background task (and the next foreground pass). */
export async function publishPromptContext(ctx: PromptContext | null, io: ClockPromptIO = realIO): Promise<void> {
  await serial(async () => {
    if (!ctx) {
      // Signed out: no context, no state, nothing left scheduled.
      const state = parsePromptState(await io.storage.get(PROMPT_STATE_KEY));
      for (const id of Object.keys(state.scheduled)) await io.notifier.cancel(id).catch(() => undefined);
      await io.storage.remove(PROMPT_CONTEXT_KEY);
      await io.storage.remove(PROMPT_STATE_KEY);
      return;
    }
    await io.storage.set(PROMPT_CONTEXT_KEY, JSON.stringify(ctx));
  });
}

export async function readPromptContext(io: ClockPromptIO = realIO): Promise<PromptContext | null> {
  return parsePromptContext(await io.storage.get(PROMPT_CONTEXT_KEY));
}

// ---------------------------------------------------------------------------
// Where each entry was clocked on (this phone's own record)
// ---------------------------------------------------------------------------
//
// The technician's sync stream doesn't carry time_entries' clock_in_lat/lng,
// so the phone remembers where IT clocked each entry on. Only the latest few.

const MAX_ANCHORS = 20;
type Anchors = Record<string, ClockFix & { atMs: number }>;

export async function rememberClockAnchor(entryId: string, fix: ClockFix | null | undefined, io: ClockPromptIO = realIO): Promise<void> {
  if (!fix) return;
  try {
    const anchors = parseJson<Anchors>(await io.storage.get(CLOCK_ANCHORS_KEY)) ?? {};
    anchors[entryId] = { ...fix, atMs: io.now() };
    const kept = Object.entries(anchors)
      .sort((a, b) => b[1].atMs - a[1].atMs)
      .slice(0, MAX_ANCHORS);
    await io.storage.set(CLOCK_ANCHORS_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Best effort: without it, that entry just gets no "left the site" prompt.
  }
}

export async function readClockAnchors(io: ClockPromptIO = realIO): Promise<Record<string, ClockFix>> {
  try {
    const anchors = parseJson<Anchors>(await io.storage.get(CLOCK_ANCHORS_KEY)) ?? {};
    const out: Record<string, ClockFix> = {};
    for (const [id, a] of Object.entries(anchors)) {
      if (Number.isFinite(a?.lat) && Number.isFinite(a?.lng)) out[id] = { lat: a.lat, lng: a.lng, accuracy: a.accuracy ?? null };
    }
    return out;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// The depot (no clock-on prompt within 300 m of it)
// ---------------------------------------------------------------------------
//
// Its coordinates are NOT in source: they could not be looked up where this
// was written, and a guessed point is worse than none. They come from the
// app's own geocoder route (/api/geocode — house/building matches only) the
// first time it is reachable, and are cached on the phone. Until then there
// is simply no depot exclusion.

const DEPOT_RETRY_FAILED_MS = 24 * 60 * 60 * 1000;
const DEPOT_RETRY_NOT_FOUND_MS = 7 * 24 * 60 * 60 * 1000;

interface DepotCache {
  lat?: number;
  lng?: number;
  /** When a lookup last failed (no signal) or found nothing. */
  failedAtMs?: number;
  notFound?: boolean;
}

/** Whether to look the depot up again. Pure — tested. */
export function depotLookupDue(cache: DepotCache | null, nowMs: number): boolean {
  if (!cache) return true;
  if (Number.isFinite(cache.lat) && Number.isFinite(cache.lng)) return false;
  const since = nowMs - (cache.failedAtMs ?? 0);
  // A clock that moved back (since < 0) waits for it to catch up.
  return since >= (cache.notFound ? DEPOT_RETRY_NOT_FOUND_MS : DEPOT_RETRY_FAILED_MS);
}

/**
 * The depot's coordinates, looking them up when due. `lookup` resolves to
 * the point, null when the geocoder can't place the address, or throws when
 * it can't be reached. Never throws.
 */
export async function depotCoords(
  lookup: () => Promise<{ lat: number; lng: number } | null>,
  io: ClockPromptIO = realIO
): Promise<{ lat: number; lng: number } | null> {
  try {
    const cache = parseJson<DepotCache>(await io.storage.get(DEPOT_KEY));
    if (cache && Number.isFinite(cache.lat) && Number.isFinite(cache.lng)) return { lat: cache.lat!, lng: cache.lng! };
    if (!depotLookupDue(cache, io.now())) return null;
    let found: { lat: number; lng: number } | null;
    try {
      found = await lookup();
    } catch {
      await io.storage.set(DEPOT_KEY, JSON.stringify({ failedAtMs: io.now() }));
      return null;
    }
    if (!found || !Number.isFinite(found.lat) || !Number.isFinite(found.lng)) {
      await io.storage.set(DEPOT_KEY, JSON.stringify({ failedAtMs: io.now(), notFound: true }));
      return null;
    }
    await io.storage.set(DEPOT_KEY, JSON.stringify({ lat: found.lat, lng: found.lng }));
    return found;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The real bindings
// ---------------------------------------------------------------------------

let channelReady = false;

const expoNotifier: PromptNotifier = {
  async schedule(n) {
    // Never asks for permission (the push registration does that); without
    // it there is no notification, and the in-app prompt still appears.
    const perm = await Notifications.getPermissionsAsync();
    if (!perm.granted) return;
    if (Platform.OS === "android" && !channelReady) {
      await Notifications.setNotificationChannelAsync("default", {
        name: "Default",
        importance: Notifications.AndroidImportance.DEFAULT,
      });
      channelReady = true;
    }
    await Notifications.scheduleNotificationAsync({
      identifier: NOTIFICATION_PREFIX + n.id,
      content: { title: n.title, body: n.body, data: { type: CLOCK_PROMPT_NOTIFICATION_TYPE } },
      trigger:
        n.atMs === null
          ? null
          : { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(n.atMs), ...(Platform.OS === "android" ? { channelId: "default" } : {}) },
    });
  },
  async cancel(id) {
    await Notifications.cancelScheduledNotificationAsync(NOTIFICATION_PREFIX + id).catch(() => undefined);
    await Notifications.dismissNotificationAsync(NOTIFICATION_PREFIX + id).catch(() => undefined);
  },
};

export const realIO: ClockPromptIO = {
  storage: {
    get: (k) => AsyncStorage.getItem(k),
    set: (k, v) => AsyncStorage.setItem(k, v),
    remove: (k) => AsyncStorage.removeItem(k),
  },
  notifier: expoNotifier,
  now: () => Date.now(),
};
