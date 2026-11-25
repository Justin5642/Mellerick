import { ADDED_BY_TECHNICIAN } from "@/lib/self-start-booking";

// The "Added by technician" tag on a board card (Justin, 25 Nov 2026): a
// technician started work on the job themselves (migration 0118 (draft)). While they
// are still clocked on the booking has no end yet, and the board draws it
// running ("· on now"). Its own file so the board's card markup only gains
// one element.
export function AddedByTechnicianTag({ booking, className }: { booking: { added_by_technician?: boolean; running?: boolean }; className?: string }) {
  if (!booking.added_by_technician) return null;
  return (
    <p
      className={`font-semibold text-emerald-700 truncate ${className ?? "text-[10px]"}`}
      title={booking.running ? `${ADDED_BY_TECHNICIAN} — still clocked on` : ADDED_BY_TECHNICIAN}
    >
      {ADDED_BY_TECHNICIAN}
      {booking.running ? " · on now" : ""}
    </p>
  );
}
