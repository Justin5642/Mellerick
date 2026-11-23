import { GEOFENCE_EXIT_BUFFER_METERS, GEOFENCE_RADIUS_METERS, MAX_READING_ACCURACY_METERS, haversineDistance } from "./geofenceState";
import { bookingWindow, clockInCostCentre, type BookingWindow } from "./bookings";
import { occupiesDay, type ScheduledJobWindow } from "./scheduling";
import { BUSINESS_TIME_ZONE, dateKeyInBusinessTZ, fromBusinessInputValue } from "./date";
import type { ClockFix } from "./clockFix";

// Clock prompts for sites the auto-clock can't see (Justin, 23 Nov 2026).
//
// The geofence auto-clock needs the site's map pin (sites.site_lat/site_lng),
// and many sites have none — new estate streets the geocoder can't place. At
// those sites nothing clocks on or off by itself. Justin approved PROMPTS, never
// a silent clock:
//
//   1. "Stopped here" (clock on): a technician with an unpinned job booked
//      TODAY, not clocked on, who stays within ~100 m for 15 minutes is asked
//      "are you at #123 …? Tap to clock on." Yes clocks on BACKDATED to the
//      first fix of the stay and pins the site from the stay's best fix.
//   2. "Left the site" (clock off): clocked on to an unpinned job and more
//      than ~250 m from where they clocked on for 10 minutes → "Left #123 at
//      3:42 pm — clock off at 3:42?" Yes clocks off backdated to the first fix
//      outside. Pinned sites are skipped — the geofence already clocks them off.
//   3. "Still on the clock" (late): any work entry still open at 17:00
//      Melbourne → "clock off now?"; asked once more at 19:00. Never backdated,
//      never automatic.
//
// Everything here is PURE: state in, state out. lib/clockPrompts.ts does the
// storage and the notifications; lib/location-tracking.tsx and the background
// task feed it fixes; components/ClockPromptSheet.tsx asks the question.
//
// THE DEVICE CLOCK LIES (HANDOVER §3). Stays and absences are timed from the
// FIXES' own timestamps. "Now" only stretches a stay past its last fix when it
// is after that fix and within MAX_SILENT_MS of it; a fix stamped before the
// previous one, or a stay longer than MAX_DWELL_MS, resets.

// ---------------------------------------------------------------------------
// Constants (one place each)
// ---------------------------------------------------------------------------

/** A stay: every fix within this of the stay's first fix (plus some of the fix's accuracy). */
export const DWELL_RADIUS_M = 100;
/** How much of a fix's own accuracy is allowed on top of DWELL_RADIUS_M. */
export const DWELL_ACCURACY_ALLOWANCE_M = 50;
/** How long a stay must last before the clock-on prompt. */
export const DWELL_MS = 15 * 60 * 1000;
/** A "stay" longer than this is a clock that moved, not a stay — it restarts. */
export const MAX_DWELL_MS = 12 * 60 * 60 * 1000;
/**
 * How long after the last fix "now" may still count as being there. A parked
 * phone gets no fixes (distance filter), so a stay is often proven by the
 * absence of movement; beyond this, only the fixes count.
 */
export const MAX_SILENT_MS = 4 * 60 * 60 * 1000;
/** A fix stamped this much before the previous one means the clock moved back. */
export const CLOCK_BACKWARD_SLACK_MS = 60 * 1000;

/** A site pin needs a fix this good: the server's own limit (MAX_PIN_ACCURACY_METRES in /api/jobs/[id]/site-location). */
export const SITE_PIN_MAX_ACCURACY_M = 50;

/** No clock-on prompt this close to the depot. */
export const DEPOT_EXCLUSION_M = 300;
/** The depot's address — its coordinates are looked up at runtime (lib/clockPrompts.ts). */
export const DEPOT_ADDRESS = "21 Quinlan Rd, Epping VIC 3076, Australia";
/** After a "No", not asked again within this of that spot the same day. */
export const DECLINED_SPOT_RADIUS_M = 200;
/**
 * A job declined at this many different spots in a day is not offered again
 * that day. (A Yes ends it at once — see acceptClockOn.)
 */
export const MAX_DECLINES_PER_JOB = 2;

/** Left the site: definitely further than this (allowing for accuracy) from the clock-on spot. */
export const LEFT_SITE_RADIUS_M = 250;
/** …for this long. */
export const LEFT_SITE_MS = 10 * 60 * 1000;
/** "Still working": not asked again about that entry for this long. */
export const STILL_WORKING_SNOOZE_MS = 60 * 60 * 1000;

/** Melbourne hours at which an open entry is asked about ("Still clocked on?"). */
export const LATE_PROMPT_HOURS = [17, 19] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One usable location reading. */
export interface PromptFix {
  lat: number;
  lng: number;
  /** Metres; null when the OS didn't say (trusted, as the geofence does). */
  accuracy: number | null;
  /** The reading's own time (epoch ms) — never the processing time. */
  atMs: number;
}

export interface DwellState {
  /** The stay's first fix — the backdated clock-on time and where. */
  start: PromptFix;
  /** The latest fix still inside the stay. */
  lastFixMs: number;
  /** The most accurate fix of the stay — the one that pins the site. */
  best: PromptFix;
}

/** An unpinned job of this technician's booked today. */
export interface PromptCandidate {
  jobId: string;
  jobNumber: number | null;
  title: string;
  /** Site name or street, for the question. */
  place: string | null;
  scheduledCostCenterId: string | null;
  /** This technician's own bookings on the job, when known. */
  bookings?: BookingWindow[];
}

/** One of this technician's open work entries. */
export interface PromptOpenEntry {
  entryId: string;
  jobId: string;
  jobNumber: number | null;
  title: string;
  clockInIso: string;
  /** The job's site has a map pin — the geofence clocks it off, so no "left" prompt. */
  pinned: boolean;
  /** Where they clocked on (this phone's record of it), if known. */
  anchor: { lat: number; lng: number; accuracy: number | null } | null;
}

export interface PromptSite {
  lat: number;
  lng: number;
  radiusM?: number;
}

/**
 * What the prompts know about the technician's day. Built by the foreground
 * (it has the data layer) and handed to the background task through storage.
 */
export interface PromptContext {
  staffId: string;
  /** The same rule as the tracking gate: a technician (or auto clock switched on), not switched off. */
  enabled: boolean;
  /** The Melbourne day `candidates` were worked out for. */
  dayKey: string;
  candidates: PromptCandidate[];
  openEntries: PromptOpenEntry[];
  /** The pinned sites the geofence watches (exclusion for the clock-on prompt). */
  pinnedSites: PromptSite[];
  /** The depot, when its coordinates are known; null = no depot exclusion. */
  depot: { lat: number; lng: number } | null;
}

export interface LeftSiteState {
  /** First fix definitely outside, or null while near the clock-on spot. */
  firstOutside: PromptFix | null;
  /** Latest fix seen for this entry (clock guard / evidence). */
  lastFixMs: number | null;
  /** "Still working" answered: not before this. */
  snoozeUntilMs: number | null;
}

export interface PromptState {
  /** The Melbourne day the per-day fields belong to. */
  dayKey: string | null;
  dwell: DwellState | null;
  declinedSpots: { lat: number; lng: number }[];
  /** Job id → spots declined at today. */
  declines: Record<string, number>;
  /** Jobs clocked on to from a prompt today (once per job per day). */
  clockedOnJobs: string[];
  left: Record<string, LeftSiteState>;
  /** Entry id → late hours already answered "still working". */
  late: Record<string, number[]>;
  /** Notification id → the prompt key it was scheduled for. */
  scheduled: Record<string, string>;
}

export const EMPTY_PROMPT_STATE: PromptState = {
  dayKey: null,
  dwell: null,
  declinedSpots: [],
  declines: {},
  clockedOnJobs: [],
  left: {},
  late: {},
  scheduled: {},
};

interface PromptBase {
  /** Stable per question — also the notification identifier. */
  id: string;
  /** Changes when it is a different question (a new stay, a new absence). */
  key: string;
  /** When it becomes askable, for scheduling a notification ahead. */
  dueAtMs: number;
  title: string;
  body: string;
}

export type ClockPrompt =
  | (PromptBase & {
      kind: "clock-on";
      startFix: PromptFix;
      bestFix: PromptFix;
      candidates: PromptCandidate[];
    })
  | (PromptBase & { kind: "left-site"; entry: PromptOpenEntry; leftFix: PromptFix })
  | (PromptBase & { kind: "late"; entry: PromptOpenEntry; hour: number });

// ---------------------------------------------------------------------------
// Fixes and stays
// ---------------------------------------------------------------------------

/** A reading worth deciding anything on, or null (bad coordinates, time, or worse than ±75 m). */
export function usableFix(reading: {
  coords: { latitude: number; longitude: number; accuracy?: number | null };
  timestamp: number;
}): PromptFix | null {
  const { latitude, longitude, accuracy } = reading.coords ?? ({} as never);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(reading.timestamp)) return null;
  const acc = typeof accuracy === "number" && Number.isFinite(accuracy) ? accuracy : null;
  if (acc !== null && acc > MAX_READING_ACCURACY_METERS) return null;
  return { lat: latitude, lng: longitude, accuracy: acc, atMs: reading.timestamp };
}

function distance(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  return haversineDistance(a.lat, a.lng, b.lat, b.lng);
}

function moreAccurate(a: PromptFix, b: PromptFix): PromptFix {
  if (b.accuracy === null) return a;
  if (a.accuracy === null) return b;
  return b.accuracy < a.accuracy ? b : a;
}

/** The next stay after `fix` (sorted readings, one at a time). */
export function advanceDwell(dwell: DwellState | null, fix: PromptFix): DwellState {
  const fresh: DwellState = { start: fix, lastFixMs: fix.atMs, best: fix };
  if (!dwell) return fresh;
  // Clock moved back, or a stay too long to be one: start again from here.
  if (fix.atMs < dwell.lastFixMs - CLOCK_BACKWARD_SLACK_MS) return fresh;
  if (fix.atMs - dwell.start.atMs > MAX_DWELL_MS) return fresh;
  const allowance = Math.min(fix.accuracy ?? 0, DWELL_ACCURACY_ALLOWANCE_M);
  if (distance(dwell.start, fix) > DWELL_RADIUS_M + allowance) return fresh;
  return { start: dwell.start, lastFixMs: Math.max(dwell.lastFixMs, fix.atMs), best: moreAccurate(dwell.best, fix) };
}

/**
 * The latest instant there is evidence for, given the last fix: "now" when it
 * is after that fix and within MAX_SILENT_MS of it (a parked phone sends
 * nothing), else the fix itself (the clock moved back, or the trail went cold).
 */
export function evidenceMs(lastFixMs: number, nowMs: number): number {
  if (Number.isFinite(nowMs) && nowMs >= lastFixMs && nowMs - lastFixMs <= MAX_SILENT_MS) return nowMs;
  return lastFixMs;
}

/** How long the stay has lasted, as far as the evidence goes. */
export function stayedMs(dwell: DwellState, nowMs: number): number {
  return evidenceMs(dwell.lastFixMs, nowMs) - dwell.start.atMs;
}

// ---------------------------------------------------------------------------
// The day's candidates
// ---------------------------------------------------------------------------

export interface JobForPrompt {
  id: string;
  job_number: number | null;
  title: string;
  status?: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  schedule_daily?: boolean | null;
  scheduled_cost_center_id?: string | null;
  sites: { name?: string | null; address_line1?: string | null; suburb?: string | null; site_lat?: number | string | null; site_lng?: number | string | null } | null;
  /** This technician's own bookings, when known (undefined = couldn't be read). */
  bookings?: BookingWindow[];
}

function hasPin(site: JobForPrompt["sites"]): boolean {
  // Truthiness, as the geofence's site list: 0/0 is an unset pin.
  return !!site && !!Number(site.site_lat) && !!Number(site.site_lng);
}

/**
 * Booked today (Melbourne), by the 0071/0079 day rules — never by
 * scheduled_start alone: this technician's own bookings when they have any,
 * else the job's own window (no bookings yet, or none of theirs).
 */
export function bookedOnDay(job: Pick<JobForPrompt, "scheduled_start" | "scheduled_end" | "schedule_daily" | "bookings">, dayKey: string): boolean {
  if (job.bookings && job.bookings.length > 0) return job.bookings.some((b) => occupiesDay(bookingWindow(b), dayKey));
  const window: ScheduledJobWindow = {
    scheduled_start: job.scheduled_start,
    scheduled_end: job.scheduled_end,
    schedule_daily: job.schedule_daily ?? false,
  };
  return occupiesDay(window, dayKey);
}

/** The jobs to ask about today: open, with a site, the site unpinned, booked today. */
export function unpinnedJobsToday(jobs: JobForPrompt[], dayKey: string): PromptCandidate[] {
  return jobs
    .filter((j) => j.status !== "completed" && j.status !== "cancelled")
    .filter((j) => !!j.sites && !hasPin(j.sites))
    .filter((j) => bookedOnDay(j, dayKey))
    .map((j) => ({
      jobId: j.id,
      jobNumber: j.job_number ?? null,
      title: j.title,
      place: placeOf(j.sites),
      scheduledCostCenterId: j.scheduled_cost_center_id ?? null,
      ...(j.bookings ? { bookings: j.bookings } : {}),
    }));
}

function placeOf(site: JobForPrompt["sites"]): string | null {
  if (!site) return null;
  const street = [site.address_line1, site.suburb].map((p) => (p ?? "").trim()).filter(Boolean).join(", ");
  return street || (site.name ?? "").trim() || null;
}

/** The cost centre a prompted clock-on uses (the manual/geofence rule). */
export function promptCostCentre(c: PromptCandidate, atMs: number): string | null {
  return clockInCostCentre(c.bookings, atMs, c.scheduledCostCenterId);
}

/** Prompts can only work for these: how many the tracking gate should count as "sites". */
export function promptSiteCount(ctx: PromptContext | null, todayKey: string): number {
  if (!ctx || !ctx.enabled) return 0;
  const candidates = ctx.dayKey === todayKey ? ctx.candidates.length : 0;
  return candidates + ctx.openEntries.filter((e) => !e.pinned && e.anchor).length;
}

// ---------------------------------------------------------------------------
// State over time
// ---------------------------------------------------------------------------

/** Per-day fields start afresh on a new Melbourne day. */
export function rollDay(state: PromptState, todayKey: string): PromptState {
  if (state.dayKey === todayKey) return state;
  return { ...EMPTY_PROMPT_STATE, dayKey: todayKey, left: state.left, scheduled: state.scheduled };
}

function advanceLeft(left: LeftSiteState | undefined, anchor: { lat: number; lng: number }, fix: PromptFix): LeftSiteState {
  let prev: LeftSiteState = left ?? { firstOutside: null, lastFixMs: null, snoozeUntilMs: null };
  // Clock moved back: the absence so far can't be timed — start it again from this fix.
  if (prev.lastFixMs !== null && fix.atMs < prev.lastFixMs - CLOCK_BACKWARD_SLACK_MS) {
    prev = { ...prev, firstOutside: null, lastFixMs: null };
  }
  const lastFixMs = Math.max(prev.lastFixMs ?? fix.atMs, fix.atMs);
  // Definitely outside: even the near edge of the fix's circle is beyond the radius.
  const outside = distance(anchor, fix) - (fix.accuracy ?? 0) > LEFT_SITE_RADIUS_M;
  if (!outside) return { ...prev, firstOutside: null, lastFixMs };
  // An absence longer than a stay can be is a moved clock.
  if (prev.firstOutside && fix.atMs - prev.firstOutside.atMs > MAX_DWELL_MS) return { ...prev, firstOutside: fix, lastFixMs };
  return { ...prev, firstOutside: prev.firstOutside ?? fix, lastFixMs };
}

/** The entries the "left the site" prompt watches. */
function leftWatched(ctx: PromptContext): PromptOpenEntry[] {
  return ctx.enabled ? ctx.openEntries.filter((e) => !e.pinned && !!e.anchor) : [];
}

/**
 * Feed readings (any order) into the state. Pure. Entries no longer open are
 * forgotten; `closedJobIds` (the background auto-clock just clocked these off)
 * count as no longer open.
 */
export function applyFixes(
  state: PromptState,
  ctx: PromptContext | null,
  fixes: PromptFix[],
  todayKey: string
): PromptState {
  let next = rollDay(state, todayKey);
  const sorted = fixes.filter((f) => Number.isFinite(f.atMs)).slice().sort((a, b) => a.atMs - b.atMs);
  let dwell = next.dwell;
  const left: Record<string, LeftSiteState> = {};
  const watched = ctx ? leftWatched(ctx) : [];
  for (const e of watched) if (next.left[e.entryId]) left[e.entryId] = next.left[e.entryId];
  for (const fix of sorted) {
    dwell = advanceDwell(dwell, fix);
    for (const e of watched) left[e.entryId] = advanceLeft(left[e.entryId], e.anchor!, fix);
  }
  // Late answers are kept only for entries still open (unknown context: kept).
  let late = next.late;
  if (ctx) {
    const openIds = new Set(ctx.openEntries.map((e) => e.entryId));
    late = {};
    for (const [id, hours] of Object.entries(next.late)) if (openIds.has(id)) late[id] = hours;
  }
  next = { ...next, dwell, left: ctx ? left : next.left, late };
  return next;
}

/** The context without entries just clocked off elsewhere. */
export function withoutClosedJobs(ctx: PromptContext | null, closedJobIds: string[]): PromptContext | null {
  if (!ctx || closedJobIds.length === 0) return ctx;
  const closed = new Set(closedJobIds);
  return { ...ctx, openEntries: ctx.openEntries.filter((e) => !closed.has(e.jobId)) };
}

// ---------------------------------------------------------------------------
// The questions
// ---------------------------------------------------------------------------

/** The stay's spot is somewhere a prompt would be wrong. */
export function clockOnExcluded(spot: { lat: number; lng: number }, ctx: PromptContext, state: PromptState): boolean {
  // Inside (the exit fence of) a pinned site: the ordinary auto-clock handles it.
  for (const s of ctx.pinnedSites) {
    if (!Number.isFinite(s.lat) || !Number.isFinite(s.lng)) continue;
    const fence = typeof s.radiusM === "number" && s.radiusM > 0 ? s.radiusM : GEOFENCE_RADIUS_METERS;
    if (distance(spot, s) <= fence + GEOFENCE_EXIT_BUFFER_METERS) return true;
  }
  if (ctx.depot && distance(spot, ctx.depot) <= DEPOT_EXCLUSION_M) return true;
  return state.declinedSpots.some((d) => distance(spot, d) <= DECLINED_SPOT_RADIUS_M);
}

/** Melbourne wall-clock time of day, e.g. "3:42 pm". */
export function timeOfDay(ms: number, withPeriod = true): string {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: BUSINESS_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hm = `${get("hour")}:${get("minute")}`;
  return withPeriod ? `${hm} ${get("dayPeriod").toLowerCase()}` : hm;
}

function jobLabel(j: { jobNumber: number | null; title: string }): string {
  return j.jobNumber != null ? `#${j.jobNumber}` : j.title;
}

export function clockOnText(candidates: PromptCandidate[]): { title: string; body: string } {
  const minutes = Math.round(DWELL_MS / 60000);
  if (candidates.length === 1) {
    const c = candidates[0];
    const where = c.place ? ` ${c.place}` : c.jobNumber != null ? ` ${c.title}` : "";
    return {
      title: "Are you on site?",
      body: `Stopped here for ${minutes} min — are you at ${jobLabel(c)}${where}? Tap to clock on.`,
    };
  }
  return {
    title: "Are you on site?",
    body: `Stopped here for ${minutes} min — are you at one of today's jobs (${candidates.map(jobLabel).join(", ")})? Tap to clock on.`,
  };
}

export function leftSiteText(entry: PromptOpenEntry, leftAtMs: number): { title: string; body: string } {
  return {
    title: "Left the site?",
    body: `Left ${jobLabel(entry)} at ${timeOfDay(leftAtMs)} — clock off at ${timeOfDay(leftAtMs, false)}?`,
  };
}

export function lateText(entry: PromptOpenEntry): { title: string; body: string } {
  return { title: "Still clocked on", body: `Still clocked on to ${jobLabel(entry)} — clock off now?` };
}

/** Epoch ms of `hour`:00 Melbourne on `dayKey`. */
export function businessHourMs(dayKey: string, hour: number): number {
  return Date.parse(fromBusinessInputValue(`${dayKey}T${String(hour).padStart(2, "0")}:00`));
}

/**
 * Every question the technician could be asked now or later today, due or
 * not (the caller schedules notifications for the ones not yet due). Sorted:
 * left the site, then clock on, then late.
 */
export function clockPrompts(state: PromptState, ctx: PromptContext | null, nowMs: number, todayKey: string): ClockPrompt[] {
  if (!ctx || !ctx.enabled) return [];
  const s = rollDay(state, todayKey);
  const out: ClockPrompt[] = [];

  // 1. Left the site.
  for (const e of leftWatched(ctx)) {
    const l = s.left[e.entryId];
    if (!l?.firstOutside) continue;
    const dueAtMs = Math.max(l.firstOutside.atMs + LEFT_SITE_MS, l.snoozeUntilMs ?? 0);
    out.push({
      kind: "left-site",
      id: `left-${e.entryId}`,
      key: `left-${e.entryId}-${l.firstOutside.atMs}`,
      dueAtMs,
      entry: e,
      leftFix: l.firstOutside,
      ...leftSiteText(e, l.firstOutside.atMs),
    });
  }

  // 2. Clock on: only when not clocked into anything, with candidates for today.
  if (s.dwell && ctx.openEntries.length === 0 && ctx.dayKey === todayKey) {
    const candidates = ctx.candidates.filter(
      (c) => !s.clockedOnJobs.includes(c.jobId) && (s.declines[c.jobId] ?? 0) < MAX_DECLINES_PER_JOB
    );
    if (candidates.length > 0 && !clockOnExcluded(s.dwell.start, ctx, s)) {
      out.push({
        kind: "clock-on",
        id: "clock-on",
        key: `on-${s.dwell.start.atMs}`,
        dueAtMs: s.dwell.start.atMs + DWELL_MS,
        startFix: s.dwell.start,
        bestFix: s.dwell.best,
        candidates,
        ...clockOnText(candidates),
      });
    }
  }

  // 3. Still on the clock late in the day.
  for (const e of ctx.openEntries) {
    const clockIn = Date.parse(e.clockInIso);
    if (!Number.isFinite(clockIn)) continue;
    const answered = s.late[e.entryId] ?? [];
    for (const hour of LATE_PROMPT_HOURS) {
      const slot = businessHourMs(todayKey, hour);
      // Only an entry that was already open at that hour, and not yet answered.
      if (!(clockIn < slot) || answered.includes(hour)) continue;
      out.push({ kind: "late", id: `late-${e.entryId}-${hour}`, key: `late-${e.entryId}-${hour}`, dueAtMs: slot, entry: e, hour, ...lateText(e) });
    }
  }
  return out;
}

/** Whether a prompt may be asked now (guarding against a clock that jumped). */
export function isDue(p: ClockPrompt, state: PromptState, nowMs: number): boolean {
  if (p.kind === "clock-on") return !!state.dwell && stayedMs(state.dwell, nowMs) >= DWELL_MS;
  if (p.kind === "left-site") {
    const l = state.left[p.entry.entryId];
    if (!l?.firstOutside || l.lastFixMs === null) return false;
    const evidence = evidenceMs(l.lastFixMs, nowMs);
    if (l.snoozeUntilMs !== null && nowMs < l.snoozeUntilMs) return false;
    return evidence - l.firstOutside.atMs >= LEFT_SITE_MS;
  }
  // Late: the clock reached the hour, and the entry's start is before now (a
  // clock that moved back before the clock-on asks nothing).
  return nowMs >= p.dueAtMs && nowMs >= Date.parse(p.entry.clockInIso);
}

/**
 * The one question to show in the app now, if any. A later late prompt
 * replaces an earlier one (asked at 19:00, not twice).
 */
export function duePrompt(state: PromptState, ctx: PromptContext | null, nowMs: number, todayKey: string): ClockPrompt | null {
  const due = clockPrompts(state, ctx, nowMs, todayKey).filter((p) => isDue(p, rollDay(state, todayKey), nowMs));
  if (due.length === 0) return null;
  const late = due.filter((p) => p.kind === "late").sort((a, b) => b.dueAtMs - a.dueAtMs);
  return due.find((p) => p.kind !== "late") ?? late[0] ?? null;
}

// ---------------------------------------------------------------------------
// Notifications to have scheduled
// ---------------------------------------------------------------------------

export interface PlannedNotification {
  id: string;
  key: string;
  /** null = now. */
  atMs: number | null;
  title: string;
  body: string;
}

/**
 * Which notifications should be waiting, and which to cancel, given what is
 * already scheduled. A prompt is scheduled ahead at its due time (a parked
 * phone sends no fixes to wake us at the 15-minute mark); a stay that breaks
 * or an entry that closes cancels it. A key already scheduled is never
 * scheduled again, so a notification shows once.
 */
export function planNotifications(
  state: PromptState,
  prompts: ClockPrompt[],
  nowMs: number
): { schedule: PlannedNotification[]; cancel: string[]; scheduled: Record<string, string> } {
  const wanted = new Map<string, PlannedNotification>();
  for (const p of prompts) {
    // Late: only the latest hour per entry that is still ahead, or due now.
    if (p.dueAtMs > nowMs) {
      wanted.set(p.id, { id: p.id, key: p.key, atMs: p.dueAtMs, title: p.title, body: p.body });
    } else if (isDue(p, state, nowMs)) {
      wanted.set(p.id, { id: p.id, key: p.key, atMs: null, title: p.title, body: p.body });
    }
  }
  // Of an entry's late prompts already due, only the latest is worth a notification.
  const lateDue = [...wanted.values()].filter((n) => n.id.startsWith("late-") && n.atMs === null);
  const latestByEntry = new Map<string, PlannedNotification>();
  for (const n of lateDue) {
    const entry = n.id.replace(/-\d+$/, "");
    const prev = latestByEntry.get(entry);
    if (!prev || n.id > prev.id) latestByEntry.set(entry, n);
  }
  for (const n of lateDue) if (latestByEntry.get(n.id.replace(/-\d+$/, "")) !== n) wanted.delete(n.id);

  const schedule: PlannedNotification[] = [];
  const cancel: string[] = [];
  const scheduled: Record<string, string> = {};
  for (const [id, key] of Object.entries(state.scheduled)) {
    const w = wanted.get(id);
    if (!w || w.key !== key) cancel.push(id);
    else scheduled[id] = key;
  }
  for (const w of wanted.values()) {
    if (scheduled[w.id] === w.key) continue;
    schedule.push(w);
    scheduled[w.id] = w.key;
  }
  return { schedule, cancel, scheduled };
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/** Yes on a clock-on prompt: that job is done for the day; the stay is used up. */
export function acceptClockOn(state: PromptState, jobId: string): PromptState {
  return { ...state, dwell: null, clockedOnJobs: [...new Set([...state.clockedOnJobs, jobId])] };
}

/** No (or dismissed): not this spot again today, and the offered jobs count one decline. */
export function declineClockOn(state: PromptState, prompt: Extract<ClockPrompt, { kind: "clock-on" }>): PromptState {
  const declines = { ...state.declines };
  for (const c of prompt.candidates) declines[c.jobId] = (declines[c.jobId] ?? 0) + 1;
  return {
    ...state,
    declines,
    declinedSpots: [...state.declinedSpots, { lat: prompt.startFix.lat, lng: prompt.startFix.lng }],
  };
}

/** "Still working": not asked about this entry for an hour, and the absence restarts. */
export function snoozeLeftSite(state: PromptState, entryId: string, nowMs: number): PromptState {
  const prev = state.left[entryId] ?? { firstOutside: null, lastFixMs: null, snoozeUntilMs: null };
  return { ...state, left: { ...state.left, [entryId]: { ...prev, firstOutside: null, snoozeUntilMs: nowMs + STILL_WORKING_SNOOZE_MS } } };
}

/** "Still working" on a late prompt: that hour (and any earlier) is answered. */
export function answerLate(state: PromptState, entryId: string, hour: number): PromptState {
  const hours = LATE_PROMPT_HOURS.filter((h) => h <= hour);
  return { ...state, late: { ...state.late, [entryId]: [...new Set([...(state.late[entryId] ?? []), ...hours])] } };
}

/** The 0092 clock fix for a prompt fix. */
export function toClockFix(f: PromptFix): ClockFix {
  return { lat: f.lat, lng: f.lng, accuracy: f.accuracy === null ? null : Math.round(f.accuracy) };
}

/** Today's Melbourne day key. */
export function todayKey(nowMs: number): string {
  return dateKeyInBusinessTZ(new Date(nowMs));
}
