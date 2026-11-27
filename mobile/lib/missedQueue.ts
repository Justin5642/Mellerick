// "Didn't make it" changes still queued on this phone (0121 (draft)). The flag is a
// side effect (ScheduleRepository.flagMissed / clearMissed), so nothing local
// changes until the server has it and the booking syncs back; screens lay the
// queued change over what they read (withQueuedMissed in ./bookingAttendance)
// so the tech sees their flag at once, offline included.
import type { Operation } from "./data/outbox/types";

export type QueuedMissed = { reason: string; note: string | null } | null;

/** bookingId → the latest queued flag (or null = a queued undo). Done and dead operations don't count. */
export function queuedMissedFlags(ops: readonly Operation[]): Map<string, QueuedMissed> {
  const out = new Map<string, QueuedMissed>();
  const live = ops
    .filter((o) => o.kind === "side_effect" && o.effect === "booking-missed" && o.status !== "done" && o.status !== "dead")
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const o of live) {
    const p = o.payload as { bookingId?: unknown; reason?: unknown; note?: unknown; clear?: unknown };
    if (typeof p.bookingId !== "string") continue;
    if (p.clear === true) out.set(p.bookingId, null);
    else if (typeof p.reason === "string") out.set(p.bookingId, { reason: p.reason, note: typeof p.note === "string" ? p.note : null });
  }
  return out;
}
