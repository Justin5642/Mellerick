import { plausibleAutoClockHours, MAX_PLAUSIBLE_TRAVEL_HOURS } from "./autoClockHours";

/**
 * The ARRIVAL / DEPARTURE half of the auto-clock.
 *
 * WHY THIS IS ITS OWN MODULE. `nextGeofenceState` was extracted from
 * LocationTrackingProvider so the *decision* could be tested and shared with the
 * background task. This is the other half — what to DO with that decision — and
 * it was still buried in a closure over three refs, where no test could reach
 * it. That is where two critical defects lived.
 *
 * THE DEFECT THIS EXISTS TO PREVENT. The provider advanced its cursor before
 * doing async work, then bailed when the network idempotence read failed:
 *
 *     insideJobIdRef.current = insideJobId;          // cursor consumed
 *     const { data, error } = await supabase...      // offline -> error, not throw
 *     if (error) { console.warn(...); return; }      // nothing enqueued
 *
 * Offline, postgrest-js resolves `{data: null, error}` rather than throwing, so
 * that branch fired, no outbox operation was created, and because the cursor had
 * already moved every later reading computed transition "none". The visit's
 * clock-in silently never existed and was never re-derived. The departure path
 * destructured the error away entirely, so the entry never closed and its hours
 * later wrote NULL. Both are unpaid labour with nothing to notice.
 *
 * THE CONTRACT THAT FIXES IT. This function never touches the cursor. It reports
 * `handled`, and the caller advances the cursor ONLY when handled is true. An
 * unresolvable lookup therefore leaves the transition to be re-derived on the
 * next position reading instead of being consumed and lost.
 *
 * The provider's own comment already argued for exactly this, for a different
 * bail: "Bailing after the cursor advanced would consume the arrival and never
 * write it — losing the visit rather than delaying it."
 */

/**
 * The idempotence lookup's answer.
 *
 * `unknown` is the case the original code did not model. It is NOT "none", and
 * treating it as "none" would clock the technician in twice; but treating it as
 * a completed transition is what lost the visit. It is its own state.
 */
export type OpenEntryLookup =
  | { status: "found"; entryId: string; clockInIso: string }
  | { status: "none" }
  | { status: "unknown"; reason: string };

export interface PendingDeparture {
  jobId: string;
  timeIso: string;
}

export interface GeofenceTransitionInput {
  kind: "arrival" | "departure";
  jobId: string;
  staffId: string;
  /** A departure awaiting the arrival that closes it into a travel leg. */
  pendingDeparture: PendingDeparture | null;
}

export interface GeofenceTransitionDeps {
  findOpenEntry(jobId: string, staffId: string): Promise<OpenEntryLookup>;
  clockIn(input: { jobId: string; staffId: string }): Promise<string>;
  clockOut(input: { entryId: string; clockInIso: string }): Promise<void>;
  addTravelLeg(input: {
    jobId: string;
    staffId: string;
    clockInIso: string;
    clockOutIso: string;
    travelFromJobId: string;
  }): Promise<void>;
  nowIso(): string;
  onWarn?(message: string): void;
}

export interface GeofenceTransitionResult {
  /**
   * True only when the transition was carried to a durable conclusion. The
   * caller MUST NOT advance its cursor when this is false — that is the whole
   * point of this module.
   */
  handled: boolean;
  /** Set after a departure so the next arrival can close the travel leg. */
  setPendingDeparture: PendingDeparture | null;
  /** True once a pending departure has been consumed, plausible or not. */
  clearPendingDeparture: boolean;
}

const NOT_HANDLED: GeofenceTransitionResult = {
  handled: false,
  setPendingDeparture: null,
  clearPendingDeparture: false,
};

export async function applyGeofenceTransition(
  input: GeofenceTransitionInput,
  deps: GeofenceTransitionDeps
): Promise<GeofenceTransitionResult> {
  const lookup = await deps.findOpenEntry(input.jobId, input.staffId);

  if (lookup.status === "unknown") {
    // "I could not check" is neither "there is one" nor "there is none".
    // Do nothing, and — critically — tell the caller the transition is still
    // outstanding so the next position reading derives it again.
    deps.onWarn?.(
      `[geofence] could not determine open-entry state for job ${input.jobId} (${lookup.reason}); ` +
        `leaving the ${input.kind} to be re-derived rather than consuming it`
    );
    return NOT_HANDLED;
  }

  if (input.kind === "arrival") {
    if (lookup.status === "none") {
      await deps.clockIn({ jobId: input.jobId, staffId: input.staffId });
    }

    const departure = input.pendingDeparture;
    if (!departure) {
      return { handled: true, setPendingDeparture: null, clearPendingDeparture: false };
    }

    const arrivalIso = deps.nowIso();
    // Null when the duration cannot be believed: a gap longer than the travel
    // ceiling is a backgrounded app rather than drive time, and a non-positive
    // one is a backward device-clock correction which would otherwise SUBTRACT
    // from the technician's pay.
    const hours = plausibleAutoClockHours(departure.timeIso, arrivalIso, MAX_PLAUSIBLE_TRAVEL_HOURS);
    if (hours !== null) {
      await deps.addTravelLeg({
        jobId: input.jobId,
        staffId: input.staffId,
        clockInIso: departure.timeIso,
        clockOutIso: arrivalIso,
        travelFromJobId: departure.jobId,
      });
    }

    // Cleared either way. Keeping an implausible departure would attach it to
    // the NEXT arrival and invent an even longer leg.
    return { handled: true, setPendingDeparture: null, clearPendingDeparture: true };
  }

  // Departure.
  if (lookup.status === "found") {
    await deps.clockOut({ entryId: lookup.entryId, clockInIso: lookup.clockInIso });
  }

  // The technician is driving whether or not there was an entry to close, so
  // the travel leg starts now. This is only reached on a resolved lookup — a
  // departure we could not close must not start a leg timed from a moment the
  // entry was never ended at.
  return {
    handled: true,
    setPendingDeparture: { jobId: input.jobId, timeIso: deps.nowIso() },
    clearPendingDeparture: false,
  };
}
