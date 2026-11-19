// Office/admin extras on the job's Time tab: logging hours for someone else
// and the admin's billing-band override (web components/job/time-entry-edit-dialog.tsx).
//
// time_entries.rate_override (0025) is ADMIN-ONLY to write — a trigger reverts
// anyone else's change — and nobody can READ it through PostgREST (0045 revoked
// the column from `authenticated`, admins included). So the phone can't show the
// current band. Editing an entry therefore opens on "Leave as it is", which
// sends nothing; only a band the admin actually picks is written. (The web
// dialog opens on "Auto" and so silently clears an existing override — a known
// gap there; this avoids repeating it.)

import type { RateOverride } from "./data/repositories/timeEntries";

/** "keep" = don't send rate_override; "auto" = send null (detect by day and time). */
export type RateChoice = "keep" | "auto" | RateOverride;

export const RATE_CHOICES: { value: RateChoice; label: string; editOnly?: boolean }[] = [
  { value: "keep", label: "Leave as it is", editOnly: true },
  { value: "auto", label: "Auto (by day & time)" },
  { value: "normal", label: "Normal" },
  { value: "time_and_half", label: "1.5×" },
  { value: "double_time", label: "2×" },
];

/**
 * What to send for the override, or undefined to send nothing. Only an admin
 * may send it, and only for a work entry (travel is never billed by the band).
 */
export function rateOverrideFor(
  choice: RateChoice,
  opts: { isAdmin: boolean; entryType: "work" | "travel" }
): RateOverride | null | undefined {
  if (!opts.isAdmin || opts.entryType === "travel" || choice === "keep") return undefined;
  return choice === "auto" ? null : choice;
}

/** Office/admin may open and correct anyone's entry (RLS 0030); everyone else only their own. */
export function canEditEntry(entry: { staff_id: string }, currentUserId: string, isOfficeOrAdmin: boolean): boolean {
  return entry.staff_id === currentUserId || isOfficeOrAdmin;
}
