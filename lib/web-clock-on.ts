// The web Time tab's own Clock In / "Switch" (Justin, 27 Nov 2026): the same
// choice the phone's clock-on sheet offers (mobile/components/job/
// clock-on-stage-picker.tsx useClockOnTarget) — the stage's own work, or one
// of the job's open (not rejected) variations (0120). Pure; the writes are the
// browser's own, as the user, so RLS and 0120's time_entries_variation_guard
// decide.
//
// The stage itself is still the web's old rule (the job's scheduled cost
// centre): the phone's manualClockOnCostCentre (mobile/lib/bookings.ts) has no
// web copy, and the web never asked for the stage.
//
// HOURS AND NAMES ONLY (HANDOVER.md §2) — no rate, amount or price.
import { openVariations, variationLabel, type VariationRef } from "./variation-time";

/** The picker's value for the stage's own work. */
export const STAGE_CHOICE = "stage";

export interface ClockOnChoice {
  /** STAGE_CHOICE or the variation's id. */
  value: string;
  label: string;
  /** null = the stage's own work. */
  variationId: string | null;
}

const STAGE_ROW: ClockOnChoice = { value: STAGE_CHOICE, label: "Stage work (not a variation)", variationId: null };

/**
 * Clock In: the stage, then each open variation. Switch (pass what they're on
 * now — null = the stage): everything but where they already are.
 */
export function clockOnChoices(variations: readonly VariationRef[], current?: string | null): ClockOnChoice[] {
  const rows: ClockOnChoice[] = [];
  if (current === undefined || current !== null) rows.push(STAGE_ROW);
  for (const v of openVariations(variations)) {
    if (current !== undefined && v.id === current) continue;
    rows.push({ value: v.id, label: variationLabel(v), variationId: v.id });
  }
  return rows;
}

/** The variation a picker value stands for (null = stage). */
export function choiceVariationId(value: string | null | undefined): string | null {
  return !value || value === STAGE_CHOICE ? null : value;
}

/**
 * Whether to offer the choice at all: the job has an open variation, and the
 * database has time_entries.variation_id — known once a read came back with
 * the key (`variationsReady`), not yet refused (`columnMissing`), or still
 * unknown because the job has no time yet (a refused clock-on then retries as
 * stage time).
 */
export function showVariationChoice(opts: { openCount: number; entryCount: number; variationsReady: boolean; columnMissing: boolean }): boolean {
  if (opts.openCount === 0 || opts.columnMissing) return false;
  return opts.variationsReady || opts.entryCount === 0;
}

/** The insert for a manual web clock-on. variation_id only when there is one, so a database without 0120 still takes stage time. */
export function clockOnRow(opts: { jobId: string; staffId: string; atIso: string; costCenterId: string | null; variationId: string | null }) {
  const row: {
    job_id: string;
    staff_id: string;
    clock_in: string;
    auto_clocked: false;
    cost_center_id: string | null;
    variation_id?: string;
  } = {
    job_id: opts.jobId,
    staff_id: opts.staffId,
    clock_in: opts.atIso,
    auto_clocked: false,
    cost_center_id: opts.costCenterId,
  };
  if (opts.variationId) row.variation_id = opts.variationId;
  return row;
}

/** "Clocked on to the variation" / "Back on the stage" — the toast after a switch. */
export function switchedText(variationId: string | null): string {
  return variationId ? "Switched to the variation — same minute, nothing lost" : "Back on the stage's own work";
}
