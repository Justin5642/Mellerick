// POST/DELETE /api/jobs/[id]/bookings/[bookingId]/missed — "Didn't make it"
// on a booking (Justin, 27 Nov 2026; migration 0121 (draft)). Request parsing and the
// fixed sentences the route answers with; flag_booking_missed() /
// clear_booking_missed() make the decision and the write. Pure.
import { validateMissed, type MissedReason } from "./booking-attendance";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export const MISSED_SENTENCES = {
  badRequest: "Something was missing from the request. Try again.",
  notAllowed: "You can only flag your own bookings.",
  notFound: "Booking not found.",
  closed: "That job is completed or cancelled — its bookings can't be changed.",
  future: "That booking hasn't started yet — you can only flag today's or an earlier booking.",
  unassigned: "That booking has no technician.",
  notSwitchedOn: "\"Didn't make it\" isn't switched on yet — tell the office instead.",
  failed: "Couldn't save that. Try again.",
} as const;

/** What the route was asked: flag with a reason, or clear (DELETE, or the phone's queued `{ clear: true }`). */
export type MissedRequest = { kind: "flag"; reason: MissedReason; note: string | null } | { kind: "clear" } | { kind: "invalid"; error: string };

export function parseMissedBody(body: unknown): MissedRequest {
  if (!body || typeof body !== "object") return { kind: "invalid", error: MISSED_SENTENCES.badRequest };
  const b = body as Record<string, unknown>;
  if (b.clear === true) return { kind: "clear" };
  const v = validateMissed({ reason: b.reason, note: b.note });
  return v.ok ? { kind: "flag", reason: v.reason, note: v.note } : { kind: "invalid", error: v.error };
}

/** The answer for an error from the 0121 (draft) functions — never the database's text. */
export function missedRpcError(error: { code?: string; message?: string } | null | undefined): { status: number; error: string } {
  switch (error?.code) {
    case "42883":
    case "PGRST202":
      return { status: 409, error: MISSED_SENTENCES.notSwitchedOn };
    case "MJ001":
      return { status: 400, error: MISSED_SENTENCES.closed };
    case "MJ141":
    case "MJ146":
    case "MJ147":
    case "MJ148":
      return { status: 400, error: MISSED_SENTENCES.badRequest };
    case "MJ142":
      return { status: 403, error: MISSED_SENTENCES.notAllowed };
    case "MJ143":
      return { status: 404, error: MISSED_SENTENCES.notFound };
    case "MJ144":
      return { status: 400, error: MISSED_SENTENCES.future };
    case "MJ145":
      return { status: 400, error: MISSED_SENTENCES.unassigned };
    default:
      return { status: 500, error: MISSED_SENTENCES.failed };
  }
}
