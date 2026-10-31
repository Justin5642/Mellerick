import { AppState } from "react-native";
import { supabase } from "./supabase";
import { plausibleAutoClockHours, MAX_PLAUSIBLE_TRAVEL_HOURS, MAX_PLAUSIBLE_WORK_HOURS } from "./autoClockHours";
import {
  BACKGROUND_CLOCK_TASK,
  applyBackgroundBatch,
  SITE_WAKE_TASK,
  backgroundGateDeps,
  backgroundTrackingDecision,
  handleSiteWake,
  siteWakeDeps,
  stopBackgroundClock,
  stopSiteWake,
  storageDeps,
  type BackgroundClockDeps,
  clockQueueStore,
} from "./backgroundClock";
import type { LocationReading } from "./backgroundClockPlan";
import { appendClockActions, replayClockActions, type QueuedClockAction } from "./backgroundClockQueue";
import { isTransientFailure, syncError } from "./data/outbox/errors";
import { cryptoIdGen } from "./data/ids";
import { fixColumns, type ClockFix } from "./clockFix";
import { reportSyncError } from "./monitoring";

// Registration of the background location task.
//
// MUST be imported for its side effect at module scope, before the app renders —
// see app/_layout.tsx. The OS can relaunch the app straight into this task with
// no UI at all, and if defineTask has not run by then the delivery is dropped
// and the readings are gone.
//
// The write bodies mirror lib/location-tracking.tsx's foreground handlers
// deliberately, including writing to Supabase directly rather than through the
// outbox: the two paths produce the SAME rows, so a technician's timesheet does
// not depend on whether the app happened to be open. Divergence here would be
// invisible and would show up only as a disputed payslip.
//
// They are no longer called straight from a delivery, though: the delivery
// QUEUES the planned actions (lib/backgroundClockQueue.ts) and these replay
// them, so a write that fails in a dead zone is retried later with its
// original timestamp instead of being re-derived (late, or never).
//
// Every failure is thrown via syncError, which marks no-signal/timeout/5xx as
// transient: those wait for the next replay without counting toward the
// action being dropped.

/** A replayed insert whose client id already exists landed the first time. */
function isReplayOfSameRow(error: { code?: string; message: string }): boolean {
  // The primary key: our own earlier attempt landed. The one-open-entry index
  // (migration 0090): the foreground watcher clocked in first. Either way the tech is clocked in, which is all this wanted.
  return error.code === "23505" && /(_pkey|time_entries_one_open_work_entry)"/.test(error.message);
}

async function insertWorkClockIn(
  jobId: string,
  at: string,
  staffId: string,
  costCenterId: string | null,
  entryId?: string,
  fix?: ClockFix | null
): Promise<void> {
  // Idempotence: if an entry is already open for this job, do nothing. The task
  // can legitimately re-derive a transition after the process is killed mid-way,
  // and a second clock-in would double-count the visit.
  const { data: openEntry, error, status } = await supabase
    .from("time_entries")
    .select("id")
    .eq("job_id", jobId)
    .eq("staff_id", staffId)
    .eq("entry_type", "work")
    .is("clock_out", null)
    .maybeSingle();
  if (error) throw syncError(`backgroundClock openEntry: ${error.message}`, status);
  if (openEntry) return;

  // The client id makes a replay idempotent even when the first attempt's
  // response was lost after the row landed (and was then closed, so the
  // open-entry check above no longer finds it).
  const { error: insertError, status: insertStatus } = await supabase.from("time_entries").insert({
    ...(entryId ? { id: entryId } : {}),
    job_id: jobId,
    staff_id: staffId,
    clock_in: at,
    auto_clocked: true,
    entry_type: "work",
    cost_center_id: costCenterId,
    ...fixColumns("clock_in", fix),
  });
  if (insertError && !isReplayOfSameRow(insertError)) {
    throw syncError(`backgroundClock clockIn: ${insertError.message}`, insertStatus);
  }
}

async function insertTravelLeg(
  toJobId: string,
  fromJobId: string,
  departedAt: string,
  arrivedAt: string,
  staffId: string,
  travelId?: string
): Promise<void> {
  // The departure instant now arrives WITH the action, from the persisted
  // pending departure, rather than being re-derived by querying the previous
  // entry's clock_out.
  //
  // That query was the second of two reasons no travel leg could ever be
  // written. In the only case the old code populated fromJobId — a single
  // reading moving straight from site A to site B — the depart and the arrive
  // were stamped from that same reading, so clock_out equalled arrivedAt, the
  // duration was zero, and plausibleAutoClockHours discarded it. The reading
  // that started the drive is the only honest start time, so it is carried.
  //
  // Null when the duration cannot be believed. A gap longer than the travel
  // ceiling means the phone was off or the departure never fired — writing it
  // anyway would put an implausible drive on someone's timesheet, and a
  // NEGATIVE one would subtract from their pay.
  const hours = plausibleAutoClockHours(departedAt, arrivedAt, MAX_PLAUSIBLE_TRAVEL_HOURS);
  if (hours === null) return;

  // The client id is what stops a replay writing the same drive twice — a
  // travel leg has no open-entry check to fall back on.
  const { error: insertError, status } = await supabase.from("time_entries").insert({
    ...(travelId ? { id: travelId } : {}),
    job_id: toJobId,
    staff_id: staffId,
    clock_in: departedAt,
    clock_out: arrivedAt,
    hours,
    entry_type: "travel",
    travel_from_job_id: fromJobId,
    auto_clocked: true,
  });
  if (insertError && !isReplayOfSameRow(insertError)) {
    throw syncError(`backgroundClock travel: ${insertError.message}`, status);
  }
}

async function closeWorkEntry(jobId: string, at: string, staffId: string, fix?: ClockFix | null): Promise<void> {
  const { data: openEntry, error, status } = await supabase
    .from("time_entries")
    .select("id, clock_in")
    .eq("job_id", jobId)
    .eq("staff_id", staffId)
    .eq("entry_type", "work")
    .is("clock_out", null)
    .maybeSingle();
  if (error) throw syncError(`backgroundClock openEntry: ${error.message}`, status);
  if (!openEntry) return;
  // A departure replayed late must not close an entry opened AFTER it — e.g.
  // the technician came back to the site and the foreground clocked them in
  // again while this departure waited out a dead zone. Closing that entry with
  // an earlier clock_out would erase the second visit.
  if (Date.parse(openEntry.clock_in) > Date.parse(at)) return;

  // The entry CLOSES either way; only `hours` is withheld when implausible, so
  // the office sees a gap to correct rather than a number that reconciles wrong.
  const hours = plausibleAutoClockHours(openEntry.clock_in, at, MAX_PLAUSIBLE_WORK_HOURS);
  const { error: updateError, status: updateStatus } = await supabase
    .from("time_entries")
    .update({ clock_out: at, ...(hours === null ? {} : { hours }), ...fixColumns("clock_out", fix) })
    .eq("id", openEntry.id);
  if (updateError) throw syncError(`backgroundClock clockOut: ${updateError.message}`, updateStatus);
}

export const supabaseClockDeps: BackgroundClockDeps = {
  ...storageDeps,
  onArrive: async (jobId, at, fromJobId, fromAt, staffId, costCenterId, ids, fix) => {
    await insertWorkClockIn(jobId, at, staffId, costCenterId, ids?.entryId, fix);
    // Both are required: fromJobId says where the drive started, fromAt says
    // when. Without the second the leg was always zero-length and discarded.
    if (fromJobId && fromAt) await insertTravelLeg(jobId, fromJobId, fromAt, at, staffId, ids?.travelId);
  },
  onDepart: async (jobId, at, staffId, fix) => {
    await closeWorkEntry(jobId, at, staffId, fix);
  },
  enqueueActions: (actions, staffId) => appendClockActions(clockQueueStore, actions, staffId, cryptoIdGen.newId),
  replayPending: async () => {
    await replayBackgroundClockQueue();
  },
};

function applyQueued(action: QueuedClockAction): Promise<void> {
  return action.type === "depart"
    ? supabaseClockDeps.onDepart(action.jobId, action.at, action.staffId, action.fix)
    : supabaseClockDeps.onArrive(
        action.jobId,
        action.at,
        action.fromJobId,
        action.fromAt,
        action.staffId,
        action.costCenterId,
        { entryId: action.entryId, travelId: action.travelId },
        action.fix
      );
}

/**
 * Replay the background auto-clock's queued actions for whoever is signed in.
 * Called from every delivery, after every outbox drain while the app is open
 * (lib/data/DataProvider.tsx), and from the background-sync task — so an
 * arrival recorded in a dead zone reaches the timesheet as soon as ANY of them
 * gets signal. Never throws. Returns how many actions are still waiting.
 */
export async function replayBackgroundClockQueue(): Promise<number> {
  try {
    const staffId = await storageDeps.readStaffId();
    return await replayClockActions(clockQueueStore, staffId, {
      apply: applyQueued,
      isTransient: isTransientFailure,
      // Rejected MAX_CLOCK_ACTION_FAILURES times: given up on so it cannot
      // block every later clock event. Reported, so the office can correct the
      // timesheet by hand. Tags only — no location, no times.
      onDropped: (_action, e) => reportSyncError(e, "background-clock"),
    });
  } catch (e) {
    console.warn("[backgroundClock] replay failed; will retry:", e);
    return 0;
  }
}

/** What expo-location hands a background task on each delivery. */
interface LocationTaskBody {
  data?: { locations?: LocationReading[] };
  error?: { message: string } | null;
}

async function handleDelivery({ data, error }: LocationTaskBody): Promise<void> {
  if (error) {
    // Nothing can be done from here — there is no UI to show and no user to
    // ask. Logging is the honest limit of what this layer can do.
    console.warn("[backgroundClock] delivery error:", error.message);
    return;
  }

  const locations: LocationReading[] = data?.locations ?? [];
  if (locations.length === 0) return;

  // While the app is on screen the foreground watcher records arrivals and
  // departures; this task got the same readings and wrote them a second time
  // (Stage 5, 31 Oct 2026 — the duplicate open entries and doubled travel
  // legs). It steps aside until the app is backgrounded.
  if (AppState.currentState === "active") return;

  try {
    await applyBackgroundBatch(locations, supabaseClockDeps);
  } catch (e) {
    // Swallowing here is deliberate and is NOT the swallowed-error bug fixed
    // elsewhere: an exception escaping a TaskManager task can make the OS stop
    // delivering to it entirely, which would silently end tracking for the rest
    // of the shift. Failed WRITES never reach here — they stay in the clock
    // queue for the next replay; only a storage fault does, and then the state
    // was not advanced, so the next delivery re-plans the same transition.
    console.warn("[backgroundClock] batch failed; will retry on next delivery:", e);
    // Not followed by the stop check below: the re-derivation this comment
    // promises needs a next delivery, and a stopped task gets none.
    return;
  }

  // Headless, nothing else would ever switch tracking off (see
  // backgroundTrackingDecision). Checked only AFTER a batch has been applied
  // and its state persisted, so the readings that prompted the stop have
  // already been recorded. Off hours the wake regions stay registered, which is
  // what brings tracking back for the next arrival.
  try {
    const decision = await backgroundTrackingDecision(backgroundGateDeps, new Date());
    if (!decision.track) {
      await stopBackgroundClock();
      if (decision.reason !== "off-hours") await stopSiteWake();
    }
  } catch (e) {
    // Unsure → keep tracking. Battery is the only cost of being wrong this way.
    console.warn("[backgroundClock] stop check failed; tracking continues:", e);
  }
}

/** What expo-location hands a geofencing task on each region event. */
interface GeofenceTaskBody {
  data?: { eventType?: number };
  error?: { message: string } | null;
}

async function handleWakeDelivery({ data, error }: GeofenceTaskBody): Promise<void> {
  if (error) {
    console.warn("[backgroundClock] site wake error:", error.message);
    return;
  }
  // Swallowed for the same reason as the location task: an exception escaping
  // a TaskManager task can stop the OS delivering to it at all.
  try {
    await handleSiteWake(data?.eventType ?? 0, siteWakeDeps);
  } catch (e) {
    console.warn("[backgroundClock] site wake failed:", e);
  }
}

interface TaskManagerModule {
  defineTask<T>(name: string, body: (payload: T) => Promise<void>): void;
}

// GUARDED, NOT STATIC — and this was not caution, it was a bug found on a device.
//
// `import * as TaskManager from "expo-task-manager"` throws at module load when
// the native module is absent, and this file is imported for its side effect at
// the very top of app/_layout.tsx. On any build without the native module — an
// existing dev client compiled before the dependency was added, Expo Go, a
// misconfigured EAS build — that threw during startup and took the ENTIRE APP
// down to a red "Cannot find native module 'ExpoTaskManager'" screen. Every
// unit test passed while that was true; only launching the app revealed it.
//
// A missing background-tracking module must degrade to "no background
// tracking", never to "no app". The foreground watcher still works, and
// startBackgroundClock reports false so the provider logs that drive time is
// only being captured while the app is open.
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const TaskManager = require("expo-task-manager") as TaskManagerModule;
  TaskManager.defineTask(BACKGROUND_CLOCK_TASK, handleDelivery);
  TaskManager.defineTask(SITE_WAKE_TASK, handleWakeDelivery);
} catch (e) {
  console.warn(
    "[backgroundClock] expo-task-manager unavailable — background tracking is OFF for this build. " +
      "Travel time will only be recorded while the app is open. Rebuild the dev client " +
      "(npx expo run:android) after adding the dependency.",
    e
  );
}
