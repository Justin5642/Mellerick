/**
 * Time against variations (migration 0120 (draft)) — the pure rules, on the phone.
 *
 * A COPY of lib/variation-time.ts: everything from the first `export` on is
 * pinned byte-identical by tests/unit/variation-time-mirror.test.ts. Change
 * the web file first, then copy it here.
 *
 * HOURS AND NAMES ONLY (HANDOVER.md §2): a technician's phone runs these.
 */

/** The parts of a variation these rules read. Money-free (the technicians' stream has them). */
export interface VariationRef {
  id: string;
  status: string;
  custom_name?: string | null;
  unit?: string | null;
  /** The office's call (0120 (draft)): true / false, null or absent = by the unit. */
  is_hourly?: boolean | null;
  /** The type's name, when the read joined it. */
  variation_types?: { name: string | null } | null;
  type_name?: string | null;
}

/** The parts of a time entry these rules read. */
export interface VariationTimeEntry {
  /** null / absent = the stage's own work (or a database before 0120 (draft)). */
  variation_id?: string | null;
  hours: number | string | null;
  clock_in: string | null;
  clock_out: string | null;
  entry_type?: string | null;
}

const HOUR_UNITS = new Set(["h", "hr", "hrs", "hour", "hours", "per hour", "/hr", "/h", "hourly"]);

/** "hr", "Hours", "per hour"… — a unit that means the variation is charged by the hour. */
export function isHourUnit(unit: string | null | undefined): boolean {
  return HOUR_UNITS.has((unit ?? "").trim().toLowerCase());
}

/** Charged by the hour: the office's call when it made one, else the unit. */
export function isHourlyVariation(v: Pick<VariationRef, "is_hourly" | "unit">): boolean {
  if (v.is_hourly === true || v.is_hourly === false) return v.is_hourly;
  return isHourUnit(v.unit);
}

/** Still takes time: not rejected. (Approved ones too — the work can carry on.) */
export function isOpenVariation(v: Pick<VariationRef, "status">): boolean {
  return v.status !== "rejected";
}

/** The variations time can go against, in the order given. */
export function openVariations<V extends Pick<VariationRef, "status">>(list: readonly V[]): V[] {
  return list.filter(isOpenVariation);
}

/** "Hit rock" — the type's name, else the custom name, else "Variation". */
export function variationName(v: Pick<VariationRef, "custom_name" | "variation_types" | "type_name">): string {
  const name = v.variation_types?.name ?? v.type_name ?? v.custom_name ?? "";
  return name.trim() || "Variation";
}

const STATUS_WORDS: Record<string, string> = {
  pending_approval: "waiting for the office",
  approved: "approved",
  auto_approved: "approved",
  rejected: "rejected",
};

/** "Variation: Hit rock (waiting for the office)" — a picker row's words. */
export function variationLabel(v: Pick<VariationRef, "custom_name" | "variation_types" | "type_name" | "status">): string {
  const words = STATUS_WORDS[v.status];
  return `Variation: ${variationName(v)}${words ? ` (${words})` : ""}`;
}

/** The entry is variation time (0120 (draft)): it does not count toward its stage's allowed hours. */
export function isVariationEntry(e: Pick<VariationTimeEntry, "variation_id">): boolean {
  return !!e.variation_id;
}

/** The entries that count toward the stage's allowed hours (and the scoreboard). */
export function stageEntries<E extends Pick<VariationTimeEntry, "variation_id">>(entries: readonly E[]): E[] {
  return entries.filter((e) => !isVariationEntry(e));
}

const hoursOf = (v: number | string | null | undefined) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export interface VariationHours {
  /** Clocked-off work hours. */
  hours: number;
  /** Someone is still clocked on to it (their time isn't in `hours` yet). */
  running: number;
}

/** Each variation's logged hours, by variation id. Work entries only; open entries counted in `running`. */
export function hoursByVariation(entries: readonly VariationTimeEntry[]): Record<string, VariationHours> {
  const out: Record<string, VariationHours> = {};
  for (const e of entries) {
    if (!e.variation_id || e.entry_type === "travel") continue;
    const row = out[e.variation_id] ?? (out[e.variation_id] = { hours: 0, running: 0 });
    if (e.clock_out) row.hours += hoursOf(e.hours);
    else if (e.clock_in) row.running += 1;
  }
  for (const id of Object.keys(out)) out[id].hours = Math.round(out[id].hours * 100) / 100;
  return out;
}

/** An hourly variation's quantity from its hours: 2 decimal places, never below 0. */
export function hourlyQuantity(hours: number): number {
  return Math.max(0, Math.round(hours * 100) / 100);
}

/** "6.5 h logged" / "6.5 h logged, 1 still clocked on" / "No time logged". */
export function variationHoursText(h: VariationHours | undefined): string {
  if (!h || (h.hours === 0 && h.running === 0)) return "No time logged";
  const base = `${Math.round(h.hours * 10) / 10} h logged`;
  return h.running > 0 ? `${base}, ${h.running} still clocked on` : base;
}

/** What a clock-on is for: a stage (cost centre) and, for variation time, the variation. */
export interface ClockOnTarget {
  costCenterId: string | null;
  variationId: string | null;
}

/**
 * "Switch to a variation" (or back to the stage) while clocked on: the open
 * entry ends and the new one starts at the SAME instant, so no minute is lost
 * or counted twice. null when there is nothing to switch (same target).
 */
export function planClockSwitch(
  open: { clock_in: string; variation_id?: string | null },
  target: ClockOnTarget,
  nowIso: string,
): { clockOutIso: string; clockInIso: string } | null {
  if ((open.variation_id ?? null) === target.variationId) return null;
  const now = Date.parse(nowIso);
  const start = Date.parse(open.clock_in);
  // Never end an entry before (or at) its own start — the database refuses it
  // (time_entries_duration_sane, 0051). One second after is the earliest.
  const at = Number.isFinite(start) && now <= start ? start + 1000 : now;
  const iso = new Date(at).toISOString();
  return { clockOutIso: iso, clockInIso: iso };
}

/** The sentence for a write 0120 (draft)'s guard refused (it raises check_violation with these). */
export function variationTimeRefusal(message: string | null | undefined): string | null {
  const m = message ?? "";
  if (/another job/i.test(m)) return "That variation is on another job.";
  if (/rejected/i.test(m)) return "That variation was rejected — time can't go against it.";
  if (/travel/i.test(m)) return "Travel time can't go against a variation.";
  return null;
}

/** A database without 0120 (draft): the column is missing (42703 from Postgres, PGRST204 from PostgREST). */
export function isMissingVariationColumn(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  const code = error.code ?? "";
  if (code !== "42703" && code !== "PGRST204" && code !== "PGRST200" && code !== "") return false;
  return /variation_id|is_hourly|variation_cost_links/.test(error.message ?? "");
}
