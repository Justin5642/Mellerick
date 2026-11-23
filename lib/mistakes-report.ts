// Reports → Mistakes (Justin, 23 Nov 2026). What mistakes cost, by company
// cost centre per month for the last 12 months, and the list behind one month
// (or one month × cost centre). Pure, so the page stays a thin loader.
//
// A mistake (job_mistakes, migration 0115 — a draft, not applied when this
// was written) is logged against one of the job's PO lines; the line's
// company cost centre (po_cost_centers.cost_centre_id, 0087) is the column.
// No line, or a line the office never tagged → "Not tagged". The month is
// occurred_on's calendar month (a plain date, already a Melbourne day).
//
// Office/admin only — amounts.

export const UNTAGGED = "untagged";
export const UNTAGGED_NAME = "Not tagged";

export interface ReportMistake {
  id: string;
  job_id: string;
  occurred_on: string;
  amount_ex_gst: number | null;
  cost_center_id: string | null;
}

export interface MistakesCell {
  amount: number;
  count: number;
}

export interface MistakesReport {
  months: string[];
  /** Columns that have any mistake in the period: company cost centres in list order, then Not tagged. */
  centres: { id: string; name: string }[];
  cells: Record<string, Record<string, MistakesCell>>;
  monthTotals: Record<string, MistakesCell>;
  centreTotals: Record<string, MistakesCell>;
  total: MistakesCell;
}

const cents = (n: number) => Math.round(n * 100) / 100;
const add = (c: MistakesCell | undefined, amount: number): MistakesCell => ({ amount: cents((c?.amount ?? 0) + amount), count: (c?.count ?? 0) + 1 });

/** The company cost centre key a mistake falls under. */
export function mistakeCentreKey(m: Pick<ReportMistake, "cost_center_id">, lineCentre: Map<string, string | null>, knownCentres: Set<string>): string {
  const centre = m.cost_center_id ? lineCentre.get(m.cost_center_id) ?? null : null;
  return centre && knownCentres.has(centre) ? centre : UNTAGGED;
}

export function mistakesByMonth(i: {
  mistakes: ReportMistake[];
  /** po_cost_centers id → its company cost centre (cost_centre_id), for the lines the mistakes name. */
  lineCentre: Map<string, string | null>;
  centres: { id: string; name: string }[];
  months: string[];
}): MistakesReport {
  const known = new Set(i.centres.map((c) => c.id));
  const inPeriod = new Set(i.months);
  const cells: MistakesReport["cells"] = {};
  const monthTotals: MistakesReport["monthTotals"] = {};
  const centreTotals: MistakesReport["centreTotals"] = {};
  let total: MistakesCell = { amount: 0, count: 0 };

  for (const m of i.mistakes) {
    const month = m.occurred_on.slice(0, 7);
    const amount = Number(m.amount_ex_gst ?? 0);
    if (!inPeriod.has(month) || !(amount > 0)) continue;
    const key = mistakeCentreKey(m, i.lineCentre, known);
    cells[month] ??= {};
    cells[month][key] = add(cells[month][key], amount);
    monthTotals[month] = add(monthTotals[month], amount);
    centreTotals[key] = add(centreTotals[key], amount);
    total = add(total, amount);
  }

  const centres = i.centres.filter((c) => centreTotals[c.id]);
  if (centreTotals[UNTAGGED]) centres.push({ id: UNTAGGED, name: UNTAGGED_NAME });
  return { months: i.months, centres, cells, monthTotals, centreTotals, total };
}

/** The mistakes behind one month (optionally one cost centre column), biggest first. */
export function mistakesInCell<T extends ReportMistake>(
  mistakes: T[],
  lineCentre: Map<string, string | null>,
  centres: { id: string }[],
  month: string,
  centreKey?: string | null
): T[] {
  const known = new Set(centres.map((c) => c.id));
  return mistakes
    .filter((m) => m.occurred_on.slice(0, 7) === month && Number(m.amount_ex_gst ?? 0) > 0)
    .filter((m) => !centreKey || mistakeCentreKey(m, lineCentre, known) === centreKey)
    .sort((a, b) => Number(b.amount_ex_gst ?? 0) - Number(a.amount_ex_gst ?? 0) || b.occurred_on.localeCompare(a.occurred_on));
}
