import { nextGeofenceState, type Coords, type TrackedSite } from "./geofenceState";

// Turn a BATCH of background location readings into clock actions.
//
// Pure on purpose. The background task has no React tree, can be started and
// killed repeatedly by the OS, and is handed several buffered readings at once —
// so the only durable state is what we persist between invocations. Expressing
// the decision as (batch, sites, previousState) -> (newState, actions) makes the
// whole thing testable without a device, which matters because the alternative
// is discovering a mistake through a technician's short pay packet.

export interface LocationReading {
  coords: Coords;
  /** Epoch milliseconds, as delivered by expo-location. */
  timestamp: number;
}

export interface ClockAction {
  type: "arrive" | "depart";
  jobId: string;
  /** ISO time of the READING, not of processing — see below. */
  at: string;
  /** On an arrival, the site just left, so travel time can be attributed. */
  fromJobId: string | null;
  /**
   * On an arrival, WHEN that site was left.
   *
   * Without it the caller had to time the leg from the departure's clock_out in
   * the database, and in the only case fromJobId was ever populated the depart
   * and arrive shared one reading — so the duration came out zero and the leg
   * was discarded as implausible. The departure instant has to travel with the
   * arrival.
   */
  fromAt: string | null;
}

/** A departure waiting for the arrival that closes it into a travel leg. */
export interface PendingDeparture {
  jobId: string;
  at: string;
}

export interface BackgroundClockPlan {
  insideJobId: string | null;
  actions: ClockAction[];
  /**
   * Persisted between invocations, exactly like insideJobId.
   *
   * The OS kills and restarts this task freely, so a drive that begins in one
   * batch and ends in the next is the normal case. Without carrying this, a leg
   * could only ever be attributed within a single batch — and since the state
   * machine reports A->away->B as two separate transitions, that meant never.
   */
  pendingDeparture: PendingDeparture | null;
}

export function planBackgroundClockActions(
  batch: LocationReading[],
  sites: TrackedSite[],
  previousInsideJobId: string | null,
  previousDeparture: PendingDeparture | null = null
): BackgroundClockPlan {
  // No sites means "not loaded yet", never "you have left everywhere". Treating
  // it as a departure would fabricate a clock-out from a failed fetch.
  if (sites.length === 0) {
    return { insideJobId: previousInsideJobId, actions: [], pendingDeparture: previousDeparture };
  }

  // Delivery order is not guaranteed. Sorting by the reading's own timestamp
  // stops an out-of-order batch manufacturing a depart-then-arrive out of what
  // was really a single arrival.
  const readings = batch
    .filter((r) => Number.isFinite(r.timestamp))
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp);

  let insideJobId = previousInsideJobId;
  // Mirrors the foreground watcher's departureRef, which is how that path has
  // always attributed legs correctly across readings.
  let pendingDeparture = previousDeparture;
  const actions: ClockAction[] = [];

  // EVERY reading is processed, not just the newest. The OS buffers readings and
  // hands over several at once, so a whole arrive-work-depart cycle can arrive
  // in one batch — and collapsing it to "where are you now" would silently drop
  // the entire visit.
  for (const reading of readings) {
    const state = nextGeofenceState(reading.coords, sites, insideJobId);
    if (state.transition === "none") continue;

    // Timestamps come from the READING. A batch can be delivered long after the
    // events in it; stamping actions with "now" would compress a two-hour visit
    // into an instant and destroy the hours it represents.
    const at = new Date(reading.timestamp).toISOString();

    if (state.transition === "departure") {
      const jobId = state.previousJobId as string;
      actions.push({ type: "depart", jobId, at, fromJobId: null, fromAt: null });
      // The technician is now driving. Remember from where and when, so the
      // arrival — which may be several readings or several INVOCATIONS later —
      // can attribute the leg.
      pendingDeparture = { jobId, at };
    } else {
      // Moving straight from one site to another is reported as a single
      // arrival by the state machine, but it is really two events: the caller
      // must close the old entry before opening the new one, or the technician
      // ends up clocked in at two jobs simultaneously.
      if (state.previousJobId) {
        actions.push({ type: "depart", jobId: state.previousJobId, at, fromJobId: null, fromAt: null });
        pendingDeparture = { jobId: state.previousJobId, at };
      }
      actions.push({
        type: "arrive",
        jobId: state.insideJobId as string,
        at,
        fromJobId: pendingDeparture?.jobId ?? null,
        fromAt: pendingDeparture?.at ?? null,
      });
      // Consumed. Leaving it set would attach the same departure to the NEXT
      // arrival too and invent a second, longer leg.
      pendingDeparture = null;
    }

    insideJobId = state.insideJobId;
  }

  return { insideJobId, actions, pendingDeparture };
}
