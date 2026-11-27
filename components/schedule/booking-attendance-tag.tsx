import { isMissed, missedDetailText, missedTagText, NOT_ATTENDED, type MissedFields } from "@/lib/booking-attendance";
import { cn } from "@/lib/utils";

// "Didn't make it — <reason>" (red; the technician flagged it, migration 0121 (draft))
// or "Not attended" (amber; computed — past, unflagged, nobody clocked on;
// office/admin only, the page sets it only for them). Justin, 27 Nov 2026.
// Its own file so each card markup only gains one element, like
// added-by-technician-tag.tsx.
export function BookingAttendanceTag({
  booking,
  className,
  who,
}: {
  booking: MissedFields & { not_attended?: boolean };
  className?: string;
  /** Whose booking, for the List tab's per-job row ("· Dan"). */
  who?: string | null;
}) {
  const suffix = who ? ` · ${who}` : "";
  if (isMissed(booking)) {
    return (
      <p
        className={cn("truncate font-semibold text-red-700", className ?? "text-[10px]")}
        title={missedDetailText(booking)}
        data-booking-missed={booking.missed_reason ?? ""}
      >
        {missedTagText(booking)}
        {suffix}
      </p>
    );
  }
  if (booking.not_attended) {
    return (
      <p
        className={cn("truncate font-semibold text-amber-700", className ?? "text-[10px]")}
        title="Booked on a day that has passed, and nobody clocked on to the job"
        data-booking-not-attended
      >
        {NOT_ATTENDED}
        {suffix}
      </p>
    );
  }
  return null;
}
