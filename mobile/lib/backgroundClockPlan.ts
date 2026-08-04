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
}

export interface BackgroundClockPlan {
  insideJobId: string | null;
  actions: ClockAction[];
}

export function planBackgroundClockActions(
  batch: LocationReading[],
  sites: TrackedSite[],
  previousInsideJobId: string | null
): BackgroundClockPlan {
  // No sites means "not loaded yet", never "you have left everywhere". Treating
  // it as a departure would fabricate a clock-out from a failed fetch.
  if (sites.length === 0) {
    return { insideJobId: previousInsideJobId, actions: [] };
  }

  // Delivery order is not guaranteed. Sorting by the reading's own timestamp
  // stops an out-of-order batch manufacturing a depart-then-arrive out of what
  // was really a single arrival.
  const readings = batch
    .filter((r) => Number.isFinite(r.timestamp))
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp);

  let insideJobId = previousInsideJobId;
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
      actions.push({ type: "depart", jobId: state.previousJobId as string, at, fromJobId: null });
    } else {
      // Moving straight from one site to another is reported as a single
      // arrival by the state machine, but it is really two events: the caller
      // must close the old entry before opening the new one, or the technician
      // ends up clocked in at two jobs simultaneously.
      if (state.previousJobId) {
        actions.push({ type: "depart", jobId: state.previousJobId, at, fromJobId: null });
      }
      actions.push({ type: "arrive", jobId: state.insideJobId as string, at, fromJobId: state.previousJobId });
    }

    insideJobId = state.insideJobId;
  }

  return { insideJobId, actions };
}
