// Mistakes, stage 5 — pattern flags (Justin, 27 Nov 2026: "see where money
// keeps leaking"). Pure: works on the mistakes the report already loads
// (lib/mistakes-data.ts, each with its money from lib/mistake-costs.ts) plus a
// few names and the open jobs' builder PO values. No migration, nothing stored —
// the flags are worked out every time the report or the Monday email is made.
//
// Office/admin only (amounts). The "same person" flag is ADMIN only: whose
// mistake it was (mistake_responsibility, 0119) is admin-only by RLS, so the
// report passes `responsible` only for an admin and the email never does.
//
// The thresholds are the constants below — change them here (no settings UI).

/** How far back the "N times in the last … days" flags look. */
export const PATTERN_WINDOW_DAYS = 90;
/** The same cause, overall and within one company cost centre. */
export const SAME_CAUSE_MIN = 3;
/** The same category. */
export const SAME_CATEGORY_MIN = 3;
/** The same supplier. */
export const SAME_SUPPLIER_MIN = 2;
/** The same builder / customer. */
export const SAME_CUSTOMER_MIN = 3;
/** The same site, ever (callbacks). */
export const SAME_SITE_MIN = 2;
/** The same person (admin only). */
export const SAME_PERSON_MIN = 2;
/** A company cost centre whose mistakes on open jobs cost more than this % of its builder PO value on those jobs. */
export const CENTRE_SHARE_PCT = 5;

export type PatternKind = "cause" | "cause_centre" | "category" | "supplier" | "customer" | "site" | "person" | "centre_share";

export interface PatternMistake {
  id: string;
  job_id: string | null;
  occurred_on: string;
  category_id: string | null;
  cause_code: string | null;
  supplier_id: string | null;
  cost_center_id: string | null;
  cost_centre_id?: string | null;
  money: { gross: number; claimed: number; recovered: number; net: number };
}

export interface PatternJob {
  customer_id: string | null;
  site_id: string | null;
  /** Open = not cancelled and not completed-and-approved (the Job margins rule). */
  open: boolean;
}

export interface PatternInput {
  mistakes: PatternMistake[];
  /** Today, YYYY-MM-DD (Melbourne). */
  today: string;
  /** po_cost_centers id → its company cost centre. */
  lineCentre: Map<string, string | null>;
  /** Company cost centres (id, name). */
  centres: { id: string; name: string }[];
  jobs: Map<string, PatternJob>;
  names: {
    category?: Map<string, string>;
    supplier?: Map<string, string>;
    customer?: Map<string, string>;
    site?: Map<string, string>;
    staff?: Map<string, string>;
    cause?: (code: string) => string | null;
  };
  /** mistake id → whose mistake. ADMIN ONLY — leave out for anyone else and no person flag is made. */
  responsible?: Map<string, string> | null;
  /** Company cost centre → the builder PO value (sum of its lines' allocated_amount) across all open jobs. */
  openCentreValue?: Map<string, number> | null;
}

export interface PatternFlag {
  /** `${kind}:${key}` — stable, for React keys. */
  id: string;
  kind: PatternKind;
  key: string;
  /** What, in words — no money. */
  title: string;
  /** The rule that raised it, e.g. "4 times in the last 90 days". */
  rule: string;
  count: number;
  gross: number;
  claimed: number;
  recovered: number;
  /** gross − recovered: what it has cost so far. */
  net: number;
  /** centre_share only: the open jobs' builder PO value for the centre, and net as a % of it. */
  value?: number;
  pct?: number;
  /** The person flag — never shown to office, never in the email. */
  adminOnly: boolean;
  /** The mistakes behind it, newest first. */
  mistakes: { id: string; job_id: string | null; occurred_on: string; net: number }[];
}

const cents = (n: number) => Math.round(n * 100) / 100;

/** YYYY-MM-DD minus `days` (calendar days, no time zone involved). */
export function daysBefore(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() - days);
  return t.toISOString().slice(0, 10);
}

function centreOf(m: PatternMistake, lineCentre: Map<string, string | null>, known: Set<string>): string | null {
  const c = (m.cost_center_id ? lineCentre.get(m.cost_center_id) ?? null : null) ?? m.cost_centre_id ?? null;
  return c && known.has(c) ? c : null;
}

function flag(kind: PatternKind, key: string, title: string, rule: string, list: PatternMistake[], adminOnly = false): PatternFlag {
  const sum = (f: (m: PatternMistake) => number) => cents(list.reduce((s, m) => s + (Number(f(m)) || 0), 0));
  return {
    id: `${kind}:${key}`,
    kind,
    key,
    title,
    rule,
    count: list.length,
    gross: sum((m) => m.money.gross),
    claimed: sum((m) => m.money.claimed),
    recovered: sum((m) => m.money.recovered),
    net: sum((m) => m.money.net),
    adminOnly,
    mistakes: [...list]
      .sort((a, b) => b.occurred_on.localeCompare(a.occurred_on) || a.id.localeCompare(b.id))
      .map((m) => ({ id: m.id, job_id: m.job_id, occurred_on: m.occurred_on, net: cents(m.money.net) })),
  };
}

function groupBy(list: PatternMistake[], keyOf: (m: PatternMistake) => string | null | undefined): Map<string, PatternMistake[]> {
  const out = new Map<string, PatternMistake[]>();
  for (const m of list) {
    const k = keyOf(m);
    if (!k) continue;
    const arr = out.get(k) ?? [];
    arr.push(m);
    out.set(k, arr);
  }
  return out;
}

const sameSet = (a: PatternMistake[], b: PatternMistake[]) => a.length === b.length && a.every((m) => b.includes(m));

/** Every pattern worth a look, worst first (net cost so far, then how many). */
export function findMistakePatterns(i: PatternInput): PatternFlag[] {
  const since = daysBefore(i.today, PATTERN_WINDOW_DAYS);
  const recent = i.mistakes.filter((m) => m.occurred_on >= since && m.occurred_on <= i.today);
  const window = `in the last ${PATTERN_WINDOW_DAYS} days`;
  const times = (n: number) => `${n} time${n === 1 ? "" : "s"} ${window}`;
  const known = new Set(i.centres.map((c) => c.id));
  const centreName = new Map(i.centres.map((c) => [c.id, c.name]));
  const causeName = (code: string) => i.names.cause?.(code) ?? code;
  const out: PatternFlag[] = [];

  // Same cause, overall…
  const byCause = groupBy(recent, (m) => m.cause_code);
  for (const [code, list] of byCause) {
    if (list.length >= SAME_CAUSE_MIN) out.push(flag("cause", code, `Cause: ${causeName(code)}`, times(list.length), list));
  }
  // …and within one company cost centre (left out when it's the whole overall flag again).
  for (const [k, list] of groupBy(recent, (m) => {
    const c = m.cause_code ? centreOf(m, i.lineCentre, known) : null;
    return c ? `${m.cause_code}|${c}` : null;
  })) {
    if (list.length < SAME_CAUSE_MIN) continue;
    const [code, centre] = k.split("|");
    const overall = byCause.get(code) ?? [];
    if (overall.length >= SAME_CAUSE_MIN && sameSet(overall, list)) {
      continue;
    }
    out.push(flag("cause_centre", k, `Cause: ${causeName(code)} in ${centreName.get(centre) ?? "a cost centre"}`, times(list.length), list));
  }

  for (const [id, list] of groupBy(recent, (m) => m.category_id)) {
    if (list.length >= SAME_CATEGORY_MIN) out.push(flag("category", id, `Category: ${i.names.category?.get(id) ?? "Category"}`, times(list.length), list));
  }
  for (const [id, list] of groupBy(recent, (m) => m.supplier_id)) {
    if (list.length >= SAME_SUPPLIER_MIN) out.push(flag("supplier", id, `Supplier: ${i.names.supplier?.get(id) ?? "Supplier"}`, times(list.length), list));
  }
  for (const [id, list] of groupBy(recent, (m) => (m.job_id ? i.jobs.get(m.job_id)?.customer_id : null))) {
    if (list.length >= SAME_CUSTOMER_MIN) out.push(flag("customer", id, `Builder: ${i.names.customer?.get(id) ?? "Customer"}`, times(list.length), list));
  }
  // Same site — ever, not just the window: a site we keep going back to.
  for (const [id, list] of groupBy(i.mistakes, (m) => (m.job_id ? i.jobs.get(m.job_id)?.site_id : null))) {
    if (list.length >= SAME_SITE_MIN) out.push(flag("site", id, `Site: ${i.names.site?.get(id) ?? "Site"}`, `${list.length} mistakes at this site (all time)`, list));
  }
  if (i.responsible) {
    const resp = i.responsible;
    for (const [id, list] of groupBy(recent, (m) => resp.get(m.id))) {
      if (list.length >= SAME_PERSON_MIN) out.push(flag("person", id, `Person: ${i.names.staff?.get(id) ?? "Staff member"}`, times(list.length), list, true));
    }
  }
  if (i.openCentreValue) {
    const onOpen = i.mistakes.filter((m) => m.job_id && i.jobs.get(m.job_id)?.open);
    for (const [centre, list] of groupBy(onOpen, (m) => centreOf(m, i.lineCentre, known))) {
      const value = cents(i.openCentreValue.get(centre) ?? 0);
      if (!(value > 0)) continue;
      const f = flag("centre_share", centre, `Cost centre: ${centreName.get(centre) ?? "Cost centre"}`, "", list);
      const pct = Math.round((f.net / value) * 1000) / 10;
      if (!(f.net / value > CENTRE_SHARE_PCT / 100)) continue;
      out.push({ ...f, value, pct, rule: `mistakes on open jobs are ${pct}% of its builder PO value (over ${CENTRE_SHARE_PCT}%)` });
    }
  }

  return out.sort((a, b) => b.net - a.net || b.count - a.count || a.id.localeCompare(b.id));
}

/** The flags a viewer may see: admin everything, anyone else without the person flags. */
export function patternsForViewer(flags: PatternFlag[], isAdmin: boolean): PatternFlag[] {
  return isAdmin ? flags : flags.filter((f) => !f.adminOnly);
}
