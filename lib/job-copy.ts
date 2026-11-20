import { nextJobPoNumber } from "@/lib/job-po-number";

// "Copy job" — use a job as a template (Justin's notebook list, 20 Nov 2026).
// A new job for the same customer and site, with the same title (prefixed
// "Copy of ", editable), job type, priority and description, and the source
// job's cost-centre LINES ready under a fresh `<new job number>-1` PO valued
// at $0 — names, company cost-centre tags and allowed hours, never an amount.
// Nothing else comes across: no bookings, time, photos, notes, documents,
// invoices, variations, schedule or money. Pure rules here; the route
// (app/api/jobs/[id]/copy) reads and writes as the office caller.

export const COPY_TITLE_MAX = 200;

export interface CopySourceJob {
  customer_id: string;
  site_id: string | null;
  title: string;
  job_type: string | null;
  priority: string | null;
  description: string | null;
}

export interface CopySourceLine {
  name: string;
  cost_centre_id: string | null;
  allocated_hours: number | string | null;
  code?: string | null;
  sort_order?: number | null;
}

/** "Copy of <title>", cut to the title limit. */
export function defaultCopyTitle(title: string): string {
  return `Copy of ${title.trim()}`.slice(0, COPY_TITLE_MAX);
}

/** The new job's title: what was typed (trimmed), else the default. Too long → null. */
export function copyTitle(requested: unknown, sourceTitle: string): string | null {
  if (typeof requested !== "string" || requested.trim() === "") return defaultCopyTitle(sourceTitle);
  const t = requested.trim();
  return t.length > COPY_TITLE_MAX ? null : t;
}

/** The new job's row — a fresh pending job; status, schedule and money are never copied. */
export function copiedJobRow(source: CopySourceJob, title: string, createdBy: string) {
  return {
    customer_id: source.customer_id,
    site_id: source.site_id,
    title,
    job_type: source.job_type,
    priority: source.priority ?? "normal",
    description: source.description,
    status: "pending",
    created_by: createdBy,
  };
}

function hours(v: number | string | null | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
}

/**
 * The template PO for the copy: `<job number>-1` at $0, its lines the source
 * lines (in order) with their hours and nothing allocated. No lines → null
 * (no empty PO is made).
 */
export function templatePo(newJobNumber: number | string, lines: readonly CopySourceLine[]) {
  const kept = lines.filter((l) => (l.name ?? "").trim() !== "");
  if (kept.length === 0) return null;
  const poLines = kept.map((l, i) => ({
    name: l.name.trim(),
    cost_centre_id: l.cost_centre_id ?? null,
    code: l.code ?? null,
    allocated_hours: hours(l.allocated_hours),
    allocated_amount: 0,
    sort_order: i,
  }));
  return {
    po: {
      po_number: nextJobPoNumber(newJobNumber, []),
      total_value: 0,
      total_hours: Math.round(poLines.reduce((s, l) => s + l.allocated_hours, 0) * 100) / 100,
    },
    lines: poLines,
  };
}
