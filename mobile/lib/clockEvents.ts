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
