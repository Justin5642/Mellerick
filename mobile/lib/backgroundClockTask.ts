import * as TaskManager from "expo-task-manager";
import { supabase } from "./supabase";
import { plausibleAutoClockHours, MAX_PLAUSIBLE_TRAVEL_HOURS, MAX_PLAUSIBLE_WORK_HOURS } from "./autoClockHours";
import {
  BACKGROUND_CLOCK_TASK,
  applyBackgroundBatch,
  storageDeps,
  type BackgroundClockDeps,
} from "./backgroundClock";
import type { LocationReading } from "./backgroundClockPlan";

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

async function insertWorkClockIn(jobId: string, at: string, staffId: string): Promise<void> {
  // Idempotence: if an entry is already open for this job, do nothing. The task
  // can legitimately re-derive a transition after the process is killed mid-way,
  // and a second clock-in would double-count the visit.
  const { data: openEntry, error } = await supabase
    .from("time_entries")
    .select("id")
    .eq("job_id", jobId)
    .eq("staff_id", staffId)
    .eq("entry_type", "work")
    .is("clock_out", null)
    .maybeSingle();
  if (error) throw new Error(`backgroundClock openEntry: ${error.message}`);
  if (openEntry) return;

  const { error: insertError } = await supabase.from("time_entries").insert({
    job_id: jobId,
    staff_id: staffId,
    clock_in: at,
    auto_clocked: true,
    entry_type: "work",
  });
  if (insertError) throw new Error(`backgroundClock clockIn: ${insertError.message}`);
}

async function insertTravelLeg(toJobId: string, fromJobId: string, arrivedAt: string, staffId: string): Promise<void> {
  // The travel leg spans the departure from the previous site to this arrival.
  // Find that departure's clock_out to bound it.
  const { data: lastDeparture, error } = await supabase
    .from("time_entries")
    .select("clock_out")
    .eq("job_id", fromJobId)
    .eq("staff_id", staffId)
    .eq("entry_type", "work")
    .not("clock_out", "is", null)
    .order("clock_out", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`backgroundClock travelBounds: ${error.message}`);
  if (!lastDeparture?.clock_out) return;

  // Null when the duration cannot be believed. A gap longer than the travel
  // ceiling means the phone was off or the departure never fired — writing it
  // anyway would put an implausible drive on someone's timesheet, and a
  // NEGATIVE one would subtract from their pay.
  const hours = plausibleAutoClockHours(lastDeparture.clock_out, arrivedAt, MAX_PLAUSIBLE_TRAVEL_HOURS);
  if (hours === null) return;

  const { error: insertError } = await supabase.from("time_entries").insert({
    job_id: toJobId,
    staff_id: staffId,
    clock_in: lastDeparture.clock_out,
    clock_out: arrivedAt,
    hours,
    entry_type: "travel",
    travel_from_job_id: fromJobId,
    auto_clocked: true,
  });
  if (insertError) throw new Error(`backgroundClock travel: ${insertError.message}`);
}

async function closeWorkEntry(jobId: string, at: string, staffId: string): Promise<void> {
  const { data: openEntry, error } = await supabase
    .from("time_entries")
    .select("id, clock_in")
    .eq("job_id", jobId)
    .eq("staff_id", staffId)
    .eq("entry_type", "work")
    .is("clock_out", null)
    .maybeSingle();
  if (error) throw new Error(`backgroundClock openEntry: ${error.message}`);
  if (!openEntry) return;

  // The entry CLOSES either way; only `hours` is withheld when implausible, so
  // the office sees a gap to correct rather than a number that reconciles wrong.
  const hours = plausibleAutoClockHours(openEntry.clock_in, at, MAX_PLAUSIBLE_WORK_HOURS);
  const { error: updateError } = await supabase
    .from("time_entries")
    .update({ clock_out: at, ...(hours === null ? {} : { hours }) })
    .eq("id", openEntry.id);
  if (updateError) throw new Error(`backgroundClock clockOut: ${updateError.message}`);
}

export const supabaseClockDeps: BackgroundClockDeps = {
  ...storageDeps,
  onArrive: async (jobId, at, fromJobId, staffId) => {
    await insertWorkClockIn(jobId, at, staffId);
    if (fromJobId) await insertTravelLeg(jobId, fromJobId, at, staffId);
  },
  onDepart: async (jobId, at, staffId) => {
    await closeWorkEntry(jobId, at, staffId);
  },
};

TaskManager.defineTask(BACKGROUND_CLOCK_TASK, async ({ data, error }: any) => {
  if (error) {
    // Nothing can be done from here — there is no UI to show and no user to
    // ask. Logging is the honest limit of what this layer can do.
    console.warn("[backgroundClock] delivery error:", error.message);
    return;
  }

  const locations: LocationReading[] = data?.locations ?? [];
  if (locations.length === 0) return;

  try {
    await applyBackgroundBatch(locations, supabaseClockDeps);
  } catch (e) {
    // Swallowing here is deliberate and is NOT the swallowed-error bug fixed
    // elsewhere: an exception escaping a TaskManager task can make the OS stop
    // delivering to it entirely, which would silently end tracking for the rest
    // of the shift. State was not persisted (applyBackgroundBatch persists only
    // after its writes), so the next delivery re-derives the same transition.
    console.warn("[backgroundClock] batch failed; will re-derive on next delivery:", e);
  }
});
