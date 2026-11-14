// Hours on a job, grouped and priced for its invoice.
//
// Pure: no database. lib/invoice-hours.ts loads the rows and writes the result
// through apply_invoice_hours() (migration 0098, draft — not applied yet); the Approvals screen and the
// invoice screen both display what groupHours() returns, so the office sees the
// same figures before approving as the invoice is built from.
//
// What counts: closed WORK entries. Travel is not billed by the hour (it was the
// flat call-out fee's job, lib/labour-billing-sync.ts), and an entry still
// clocked on has no end to price. Hours come from the clock times, not the
// stored `hours` column, so a corrected clock-off is always what gets billed.

export interface HoursEntry {
  id: string;
  staff_id: string;
  staff_name: string | null;
  cost_center_id: string | null;
  cost_center_name: string | null;
  entry_type: string | null;
  clock_in: string;
  clock_out: string | null;
  /** The invoice these hours are already billed on (0098), or null. */
  invoice_id: string | null;
  /**
   * Billed by an auto "Labour" job item (job_items.time_entry_id, written by
   * lib/labour-billing-sync.ts before 0086 switched it off). Approval copies
   * that line onto the invoice, so these hours are already billed — pricing
   * them again would charge them twice (#2538, #2522, #639 have such lines).
   */
  labour_line?: boolean;
}

/** Already billed: on an invoice, or covered by an auto Labour job item. */
export function isBilled(e: Pick<HoursEntry, "invoice_id" | "labour_line">): boolean {
  return e.invoice_id != null || !!e.labour_line;
}

export interface HoursGroup {
  /** `${costCentreKey}|${staffId}` — stable across loads. */
  key: string;
  costCentreKey: string;
  costCentreName: string | null;
  staffId: string;
  staffName: string;
  hours: number;
  entryIds: string[];
}

/** Map key for hours logged against no cost centre. */
export const NO_COST_CENTRE = "none";

const round2 = (n: number) => Math.round(n * 100) / 100;

export function isBillableEntry(e: Pick<HoursEntry, "entry_type" | "clock_in" | "clock_out">): boolean {
  return e.entry_type === "work" && !!e.clock_out && entryHours(e) > 0;
}

export function entryHours(e: Pick<HoursEntry, "clock_in" | "clock_out">): number {
  if (!e.clock_out) return 0;
  const ms = new Date(e.clock_out).getTime() - new Date(e.clock_in).getTime();
  return Number.isFinite(ms) && ms > 0 ? ms / 3_600_000 : 0;
}

/** Billable entries grouped by cost centre, then technician. Hours are rounded once, per group. */
export function groupHours(entries: HoursEntry[]): HoursGroup[] {
  const groups = new Map<string, HoursGroup & { rawHours: number }>();
  for (const e of entries) {
    if (!isBillableEntry(e)) continue;
    const costCentreKey = e.cost_center_id ?? NO_COST_CENTRE;
    const key = `${costCentreKey}|${e.staff_id}`;
    const g = groups.get(key) ?? {
      key,
      costCentreKey,
      costCentreName: e.cost_center_name ?? null,
      staffId: e.staff_id,
      staffName: e.staff_name?.trim() || "Unknown staff",
      hours: 0,
      rawHours: 0,
      entryIds: [],
    };
    g.rawHours += entryHours(e);
    g.entryIds.push(e.id);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map(({ rawHours, ...g }) => ({ ...g, hours: round2(rawHours) }))
    // Under 18 seconds rounds to 0.00h — nothing to bill, and an invoice line
    // of zero hours is refused by apply_invoice_hours().
    .filter((g) => g.hours > 0)
    .sort(
      (a, b) =>
        (a.costCentreName ?? "￿").localeCompare(b.costCentreName ?? "￿") ||
        a.staffName.localeCompare(b.staffName)
    );
}

export function totalHours(groups: Pick<HoursGroup, "hours">[]): number {
  return round2(groups.reduce((s, g) => s + g.hours, 0));
}

// ---------------------------------------------------------------------------
// Rates
// ---------------------------------------------------------------------------

export type RateMode = "all" | "technician" | "cost_centre";

export interface RateChoice {
  mode: RateMode;
  all?: number | null;
  byStaff?: Record<string, number | null | undefined>;
  byCostCentre?: Record<string, number | null | undefined>;
}

export type RateSource = "quote" | "charge_out" | "company";

export interface RateDefaults {
  all: number;
  allSource: RateSource;
  byStaff: Record<string, { rate: number; source: RateSource }>;
  byCostCentre: Record<string, { rate: number; source: RateSource }>;
}

/**
 * The hourly rate on a job's quote: the first line priced from an `hourly`
 * pricing item. Quoted jobs bill hours at the quoted rate (Justin, 14 Nov
 * 2026). Lines are expected oldest first.
 */
export function quoteHourlyRate(
  lines: Array<{ unit_price: number | string | null; pricing_type: string | null }>
): number | null {
  for (const l of lines) {
    const price = Number(l.unit_price);
    if (l.pricing_type === "hourly" && Number.isFinite(price) && price > 0) return price;
  }
  return null;
}

/**
 * Default rate for each way of pricing:
 *   quoted job        -> the quote's hourly rate, for everyone;
 *   otherwise         -> the technician's own charge-out rate where one is set,
 *                        else the company's ordinary rate (Settings → billing).
 */
export function defaultRates(input: {
  groups: HoursGroup[];
  quoteRate: number | null;
  chargeOutByStaff: Record<string, number | null | undefined>;
  companyRate: number;
}): RateDefaults {
  const { groups, quoteRate, chargeOutByStaff, companyRate } = input;
  const base = quoteRate != null
    ? { rate: quoteRate, source: "quote" as const }
    : { rate: companyRate, source: "company" as const };

  const byStaff: RateDefaults["byStaff"] = {};
  const byCostCentre: RateDefaults["byCostCentre"] = {};
  for (const g of groups) {
    const own = Number(chargeOutByStaff[g.staffId]);
    byStaff[g.staffId] =
      quoteRate == null && Number.isFinite(own) && own > 0 ? { rate: own, source: "charge_out" } : base;
    byCostCentre[g.costCentreKey] = base;
  }
  return { all: base.rate, allSource: base.source, byStaff, byCostCentre };
}

export function rateForGroup(group: HoursGroup, choice: RateChoice): number | null {
  const raw =
    choice.mode === "all"
      ? choice.all
      : choice.mode === "technician"
        ? choice.byStaff?.[group.staffId]
        : choice.byCostCentre?.[group.costCentreKey];
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? round2(n) : null;
}

// ---------------------------------------------------------------------------
// Invoice lines
// ---------------------------------------------------------------------------

export interface HourLine {
  name: string;
  description: string;
  quantity: number;
  unit_price: number;
  entry_ids: string[];
}

/** One invoice line per cost centre x technician, at the chosen rate. */
export function buildHourLines(
  groups: HoursGroup[],
  choice: RateChoice
): { ok: true; lines: HourLine[] } | { ok: false; error: string } {
  if (groups.length === 0) return { ok: false, error: "There are no hours to bill on this job." };
  const lines: HourLine[] = [];
  for (const g of groups) {
    const rate = rateForGroup(g, choice);
    if (rate == null) {
      const who =
        choice.mode === "technician" ? g.staffName : choice.mode === "cost_centre" ? (g.costCentreName ?? "hours with no cost centre") : "all hours";
      return { ok: false, error: `Enter an hourly rate for ${who}.` };
    }
    lines.push({
      name: g.costCentreName ? `Labour — ${g.costCentreName}` : "Labour",
      description: `${g.staffName} — ${g.hours.toFixed(2)}h @ $${rate.toFixed(2)}/hr`,
      quantity: g.hours,
      unit_price: rate,
      entry_ids: g.entryIds,
    });
  }
  return { ok: true, lines };
}
