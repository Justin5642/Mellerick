// MIRROR of the web's lib/komtrax-meter.ts (Day Works engine-hour lines
// prefilled from Komtrax, 0113). The body below is identical, pinned by
// tests/unit/komtrax-mirror.test.ts — change the web file first, then copy
// its body here.

/** One Melbourne day of a machine's hour meter. Hours only — never money. */
export interface MeterDay {
  open: number;
  close: number;
  first_at: string;
  last_at: string;
  readings: number;
}

/** equipment id → Melbourne day (YYYY-MM-DD) → that day's meter. */
export type MeterReadings = Record<string, Record<string, MeterDay>>;

/** Group readings (any order) into days; `dayOf` turns an instant into a Melbourne YYYY-MM-DD. */
export function meterDays(readings: { read_at: string; hours: number | string }[], dayOf: (iso: string) => string): Record<string, MeterDay> {
  const sorted = readings
    .map((r) => ({ read_at: r.read_at, hours: Number(r.hours) }))
    .filter((r) => Number.isFinite(r.hours))
    .sort((a, b) => a.read_at.localeCompare(b.read_at));
  const out: Record<string, MeterDay> = {};
  for (const r of sorted) {
    const day = dayOf(r.read_at);
    const d = out[day];
    if (!d) out[day] = { open: r.hours, close: r.hours, first_at: r.read_at, last_at: r.read_at, readings: 1 };
    else {
      d.close = r.hours;
      d.last_at = r.read_at;
      d.readings += 1;
    }
  }
  return out;
}

/** The meter fields of a Day Works draft (web and phone share this shape). */
export interface MeterDraft {
  id: string | null;
  equipment_id: string;
  work_date: string;
  /** "<hire_type>|<hire_unit>" */
  optionKey: string;
  meter_open: string;
  meter_close: string;
  /** What Komtrax last put in the two fields; null = nothing (or the crew typed over it). */
  meter_auto?: { open: string; close: string } | null;
}

const fmt = (n: number) => String(Math.round(n * 10) / 10);

/**
 * The draft with its meter fields filled from Komtrax, when that is safe:
 * a NEW engine-hour line whose two fields are empty or still exactly what
 * Komtrax filled. Changing the machine or date refills (or clears what
 * Komtrax filled when there is no reading that day). Anything typed stays.
 */
export function prefillMeters<D extends MeterDraft>(draft: D, readings: MeterReadings | null | undefined): D {
  if (draft.id) return draft;
  const unit = draft.optionKey.split("|")[1] ?? "";
  const auto = draft.meter_auto ?? null;
  const untouched =
    (draft.meter_open === "" && draft.meter_close === "") ||
    (auto !== null && draft.meter_open === auto.open && draft.meter_close === auto.close);
  if (!untouched) return draft.meter_auto ? { ...draft, meter_auto: null } : draft;
  const day = unit === "engine_hour" ? readings?.[draft.equipment_id]?.[draft.work_date] : undefined;
  if (!day) {
    if (!auto) return draft;
    return { ...draft, meter_open: "", meter_close: "", meter_auto: null };
  }
  const next = { open: fmt(day.open), close: fmt(day.close) };
  if (auto && auto.open === next.open && auto.close === next.close && draft.meter_open === next.open) return draft;
  return { ...draft, meter_open: next.open, meter_close: next.close, meter_auto: next };
}

/** The note under the meter fields when Komtrax filled them. */
export function meterNote(draft: MeterDraft, readings: MeterReadings | null | undefined): string | null {
  const day = readings?.[draft.equipment_id]?.[draft.work_date];
  if (!day) return null;
  const filled = draft.meter_auto && draft.meter_open === draft.meter_auto.open && draft.meter_close === draft.meter_auto.close;
  const span = day.readings === 1 ? "one Komtrax reading that day" : `first and last of ${day.readings} Komtrax readings that day`;
  return filled ? `Filled from Komtrax (${span}). Check against the machine's meter.` : `Komtrax read ${fmt(day.open)} → ${fmt(day.close)} that day.`;
}
