// Reads what the pattern flags (lib/mistake-patterns.ts) need beyond the
// mistakes themselves: the mistakes' jobs (customer, site, open or not), the
// names, the company cost centre of each mistake's PO line, and every open
// job's builder PO value per company cost centre. Runs under whoever the
// client is — the report as the viewer (office/admin, RLS), the Monday email
// with the service role. Whose mistake it was is read only when `withPeople`
// (admin viewer) — never for office, never for the email.

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import { billingName } from "@/lib/customer-billing";
import { causeLabel } from "@/lib/mistake-raise";
import { findMistakePatterns, type PatternFlag, type PatternInput, type PatternJob, type PatternMistake } from "@/lib/mistake-patterns";

const CHUNK = 100;

async function byIds<T>(db: SupabaseClient, table: string, columns: string, ids: string[], column = "id"): Promise<T[]> {
  const out: T[] = [];
  const uniq = [...new Set(ids)];
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const { data, error } = await db.from(table).select(columns).in(column, uniq.slice(i, i + CHUNK));
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

const isOpenJob = (j: { status: string | null; admin_status: string | null }) =>
  j.status !== "cancelled" && !(j.status === "completed" && j.admin_status === "approved");

export async function loadPatternContext(
  db: SupabaseClient,
  mistakes: PatternMistake[],
  opts: { withPeople: boolean; today: string }
): Promise<PatternInput> {
  const jobIds = mistakes.map((m) => m.job_id).filter((id): id is string => !!id);
  const lineIds = mistakes.map((m) => m.cost_center_id).filter((id): id is string => !!id);

  const [centresRes, jobRows, lineRows, catsRes, sups, openJobsRes] = await Promise.all([
    db.from("cost_centres").select("id, name"),
    byIds<{ id: string; customer_id: string | null; site_id: string | null; status: string | null; admin_status: string | null }>(
      db, "jobs", "id, customer_id, site_id, status, admin_status", jobIds
    ),
    byIds<{ id: string; cost_centre_id: string | null }>(db, "po_cost_centers", "id, cost_centre_id", lineIds),
    db.from("mistake_categories").select("id, name"),
    byIds<{ id: string; name: string }>(db, "suppliers", "id, name", mistakes.map((m) => m.supplier_id).filter((id): id is string => !!id)),
    fetchAllRows<{ id: string; status: string | null; admin_status: string | null }>(
      (count) => db.from("jobs").select("id, status, admin_status", count).neq("status", "cancelled").order("id") as never
    ),
  ]);
  if (centresRes.error) throw new Error(`cost_centres: ${centresRes.error.message}`);
  if (!openJobsRes.ok) throw new Error(`jobs: ${openJobsRes.error}`);

  const jobs = new Map<string, PatternJob>(jobRows.map((j) => [j.id, { customer_id: j.customer_id, site_id: j.site_id, open: isOpenJob(j) }]));
  const lineCentre = new Map(lineRows.map((l) => [l.id, l.cost_centre_id]));

  const [customers, sites] = await Promise.all([
    byIds<{ id: string; name: string | null; company: string | null }>(db, "customers", "id, name, company", jobRows.map((j) => j.customer_id).filter((id): id is string => !!id)),
    byIds<{ id: string; name: string | null; address_line1: string | null; suburb: string | null }>(
      db, "sites", "id, name, address_line1, suburb", jobRows.map((j) => j.site_id).filter((id): id is string => !!id)
    ),
  ]);

  // Builder PO value per company cost centre across every open job.
  const openJobIds = openJobsRes.rows.filter(isOpenJob).map((j) => j.id);
  const pos = await byIds<{ id: string }>(db, "purchase_orders", "id", openJobIds, "job_id");
  const lines = await byIds<{ cost_centre_id: string | null; allocated_amount: number | null }>(
    db, "po_cost_centers", "cost_centre_id, allocated_amount", pos.map((p) => p.id), "po_id"
  );
  const openCentreValue = new Map<string, number>();
  for (const l of lines) {
    if (!l.cost_centre_id) continue;
    openCentreValue.set(l.cost_centre_id, (openCentreValue.get(l.cost_centre_id) ?? 0) + Number(l.allocated_amount ?? 0));
  }

  let responsible: Map<string, string> | null = null;
  const staff = new Map<string, string>();
  if (opts.withPeople) {
    const resp = await byIds<{ mistake_id: string; staff_id: string }>(db, "mistake_responsibility", "mistake_id, staff_id", mistakes.map((m) => m.id), "mistake_id");
    responsible = new Map(resp.map((r) => [r.mistake_id, r.staff_id]));
    for (const p of await byIds<{ id: string; full_name: string | null }>(db, "profiles", "id, full_name", resp.map((r) => r.staff_id))) {
      staff.set(p.id, p.full_name ?? "Staff member");
    }
  }

  return {
    mistakes,
    today: opts.today,
    lineCentre,
    centres: (centresRes.data ?? []) as { id: string; name: string }[],
    jobs,
    names: {
      category: new Map(((catsRes.data ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name])),
      supplier: new Map(sups.map((s) => [s.id, s.name])),
      customer: new Map(customers.map((c) => [c.id, billingName(c) || "Customer"])),
      site: new Map(sites.map((s) => [s.id, [s.address_line1, s.suburb].filter(Boolean).join(", ") || s.name || "Site"])),
      staff,
      cause: causeLabel,
    },
    responsible,
    openCentreValue,
  };
}

/** Load the context and find the patterns. */
export async function loadMistakePatterns(
  db: SupabaseClient,
  mistakes: PatternMistake[],
  opts: { withPeople: boolean; today: string }
): Promise<PatternFlag[]> {
  return findMistakePatterns(await loadPatternContext(db, mistakes, opts));
}
