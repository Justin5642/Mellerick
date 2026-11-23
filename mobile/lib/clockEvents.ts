// "A time entry just changed on this device."
//
// The location-tracking gate (lib/trackingGate.ts) keeps GPS on whenever the
// technician is on the clock, and must hear about a clock-in or clock-out the
// moment it is queued — not at the next periodic re-check, by which time a
// technician who clocked in at 18:59 could already have had tracking switched
// off for the evening. TimeEntriesRepository calls notifyClockChanged after
// every time-entry write it enqueues; LocationTrackingProvider listens.
//
// A plain module-level emitter rather than React context because the writer is
// a repository, not a component.

type Listener = () => void;
const listeners = new Set<Listener>();

export function onClockChanged(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function notifyClockChanged(): void {
  for (const cb of listeners) {
    // A listener that throws must not fail the write that already succeeded.
    try {
      cb();
    } catch (e) {
      console.warn("[clockEvents] listener failed:", e);
    }
  }
}

// "This device just clocked someone on, here." The clock prompts
// (lib/clockPrompts.ts) remember where each entry was clocked on, because the
// technician's sync stream doesn't carry time_entries' clock_in_lat/lng and
// the "left the site" prompt measures from that spot.

export interface ClockedInEvent {
  entryId: string;
  jobId: string;
  fix: { lat: number; lng: number; accuracy: number | null } | null;
}
type ClockedInListener = (e: ClockedInEvent) => void;
const clockedInListeners = new Set<ClockedInListener>();

export function onClockedIn(cb: ClockedInListener): () => void {
  clockedInListeners.add(cb);
  return () => {
    clockedInListeners.delete(cb);
  };
}

export function notifyClockedIn(e: ClockedInEvent): void {
  for (const cb of clockedInListeners) {
    try {
      cb(e);
    } catch (err) {
      console.warn("[clockEvents] clocked-in listener failed:", err);
    }
  }
}
