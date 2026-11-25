// Reports → Mistakes (Justin, 23 Nov 2026). What mistakes cost, by company
// cost centre per month for the last 12 months, and the list behind one month
// (or one month × cost centre). Pure, so the page stays a thin loader.
//
// A mistake (job_mistakes, 0115/0119 (a draft, not applied yet)) is logged against one of the job's PO
// lines; the line's company cost centre (po_cost_centers.cost_centre_id, 0087)
// is the column — or, for a mistake with no job (0119), the company cost
// centre recorded on it. Neither → "Not tagged". The month is occurred_on's
// calendar month (a plain date, already a Melbourne day).
//
// 0119 adds the breakdowns below the month table: by category, cause,
// supplier (credits claimed vs received), person (admin only), job (as a % of
// the job's value) and the open items. Each works on a mistake with its money
// (lib/mistake-costs.ts mistakeMoney) already attached.
//
// Office/admin only — amounts.

export const UNTAGGED = "untagged";
export const UNTAGGED_NAME = "Not tagged";

export interface ReportMistake {
  id: string;
  job_id: string | null;
  occurred_on: string;
  /** What the mistake cost, ex GST (0119: its cost lines' gross; 0115: its amount). */
  amount_ex_gst: number | null;
  cost_center_id: string | null;
  /** The company cost centre recorded on the mistake (0119) — a mistake with no job has only this. */
  cost_centre_id?: string | null;
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
export function mistakeCentreKey(
  m: Pick<ReportMistake, "cost_center_id" | "cost_centre_id">,
  lineCentre: Map<string, string | null>,
  knownCentres: Set<string>
): string {
  const centre = (m.cost_center_id ? lineCentre.get(m.cost_center_id) ?? null : null) ?? m.cost_centre_id ?? null;
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

// ---------------------------------------------------------------------------
// 0119 breakdowns
// ---------------------------------------------------------------------------

export interface MoneyMistake {
  id: string;
  job_id: string | null;
  occurred_on: string;
  status: string;
  category_id: string | null;
  cause_code: string | null;
  supplier_id: string | null;
  money: { gross: number; recovered: number; claimed: number; net: number; manual: number };
}

export interface GroupRow {
  key: string;
  count: number;
  /** All cost lines. */
  gross: number;
  claimed: number;
  recovered: number;
  /** gross − recovered. */
  net: number;
}

export const NONE = "none";

/** Mistakes grouped by a key (null → NONE), biggest net cost first. */
export function groupMistakes<T extends MoneyMistake>(mistakes: T[], keyOf: (m: T) => string | null | undefined): GroupRow[] {
  const rows = new Map<string, GroupRow>();
  for (const m of mistakes) {
    const key = keyOf(m) || NONE;
    const r = rows.get(key) ?? { key, count: 0, gross: 0, claimed: 0, recovered: 0, net: 0 };
    r.count += 1;
    r.gross = cents(r.gross + m.money.gross);
    r.claimed = cents(r.claimed + m.money.claimed);
    r.recovered = cents(r.recovered + m.money.recovered);
    r.net = cents(r.net + m.money.net);
    rows.set(key, r);
  }
  return [...rows.values()].sort((a, b) => b.net - a.net || b.count - a.count || a.key.localeCompare(b.key));
}

export interface JobMistakeRow extends GroupRow {
  /** Sum of the job's builder PO values (purchase_orders.total_value); 0 = none. */
  jobValue: number;
  /** Net mistake cost as a % of the job's value; null with no value. */
  pctOfValue: number | null;
}

/** Mistake cost per job, as a share of what the job is worth. Mistakes with no job are left out. */
export function mistakesByJob<T extends MoneyMistake>(mistakes: T[], jobValue: Map<string, number>): JobMistakeRow[] {
  return groupMistakes(
    mistakes.filter((m) => m.job_id),
    (m) => m.job_id
  )
    .map((r) => {
      const value = cents(jobValue.get(r.key) ?? 0);
      return { ...r, jobValue: value, pctOfValue: value > 0 ? Math.round((r.net / value) * 1000) / 10 : null };
    })
    .sort((a, b) => (b.pctOfValue ?? -1) - (a.pctOfValue ?? -1) || b.net - a.net);
}

/**
 * The open items: mistakes still costing money with nothing claimed back —
 * net cost above $0, no recovery claimed — plus every mistake not yet closed.
 * Oldest first, so the longest-waiting gets looked at.
 */
export function openItems<T extends MoneyMistake>(mistakes: T[]): { unrecovered: T[]; notClosed: T[]; unrecoveredTotal: number } {
  const byAge = (a: T, b: T) => a.occurred_on.localeCompare(b.occurred_on) || a.id.localeCompare(b.id);
  const unrecovered = mistakes.filter((m) => m.money.net > 0 && !(m.money.claimed > 0)).sort(byAge);
  return {
    unrecovered,
    notClosed: mistakes.filter((m) => m.status !== "closed").sort(byAge),
    unrecoveredTotal: cents(unrecovered.reduce((s, m) => s + m.money.net, 0)),
  };
}

/** Credits claimed but not yet received — the "open recoverable" figure in the Monday email. */
export function openRecoverable(mistakes: { recovery_claimed_ex_gst?: number | null; recovered_ex_gst?: number | null }[]): number {
  return cents(
    mistakes.reduce((s, m) => s + Math.max(0, Number(m.recovery_claimed_ex_gst ?? 0) - Number(m.recovered_ex_gst ?? 0)), 0)
  );
}
