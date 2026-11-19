// What the phone's booking cost centre picker offers, and its one write (19 Nov
// 2026 — every booking asks for a cost centre). Office/admin screens only:
// the Schedule Job sheet, the Schedule tab's to-do placing and New Job.
//
// - The job's PO lines: getJobCostCentres (local-first for office/admin —
//   office devices hold po_cost_centers).
// - The company cost centres (cost_centres, 0087): ONLINE, they are in no
//   PowerSync stream. The last list read is kept in memory, so a sheet opened
//   again without signal still offers it.
// - "Add to this job": POST /api/jobs/[id]/booking-cost-centre (online only,
//   run as the caller under RLS) — adds a $0 line, or makes the job's `<n>-1`
//   PO at $0 first. Offline: "Adding a cost centre needs signal."
//
// Names and ids only — no money.
import { supabase } from "./supabase";
import { officeApi, OfficeApiError } from "./officeApi";
import { ADD_COST_CENTRE_OFFLINE, type BookingLineOption, type CompanyCostCentreOption } from "./bookingCostCentre";
import { getJobCostCentres } from "./data/reads/jobBilling";

let companyCache: CompanyCostCentreOption[] | null = null;

/** The company's active cost centres; the last list read when offline; [] when never read. */
export async function loadCompanyCostCentres(): Promise<{ list: CompanyCostCentreOption[]; online: boolean }> {
  try {
    const { data, error } = await supabase.from("cost_centres").select("id, name").eq("is_active", true).order("sort_order");
    if (error) throw error;
    companyCache = ((data ?? []) as CompanyCostCentreOption[]).map((c) => ({ id: c.id, name: c.name }));
    return { list: companyCache, online: true };
  } catch {
    return { list: companyCache ?? [], online: false };
  }
}

/** The job's PO lines as the picker shows them. [] when they can't be read. */
export async function loadJobLines(jobId: string): Promise<BookingLineOption[]> {
  try {
    const rows = await getJobCostCentres(jobId);
    return rows.map((r) => ({ id: r.id, name: r.name, po_number: r.po_number ?? null }));
  } catch {
    return [];
  }
}

export interface AddedLine {
  id: string;
  name: string;
  cost_centre_id: string;
  po_number: string | null;
}

/** Adds the company cost centre to the job (or finds its line). Throws the server's sentence, or ADD_COST_CENTRE_OFFLINE. */
export async function addCostCentreToJob(jobId: string, costCentreId: string): Promise<AddedLine> {
  try {
    const res = await officeApi<{ line: AddedLine }>(`/api/jobs/${encodeURIComponent(jobId)}/booking-cost-centre`, {
      method: "POST",
      body: { costCentreId },
    });
    return res.line;
  } catch (e) {
    if (e instanceof OfficeApiError && e.status === 0 && e.message.startsWith("No connection")) throw new Error(ADD_COST_CENTRE_OFFLINE);
    throw e;
  }
}
