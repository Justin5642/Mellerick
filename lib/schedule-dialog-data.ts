// What a job's Schedule dialog (components/job/schedule-job-dialog.tsx) needs,
// shared by the two places it opens: the job page (loaded on the server) and
// the schedule board (loaded in the browser when the office picks a job and a
// technician's day — 23 Nov 2026, "schedule without leaving the board").
// One set of rules, so the dialog behaves the same from either.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";
import { bookingsFromJobWindow, loadJobBookings, nameBookings, type JobBookingWithNames } from "./bookings";

type Client = SupabaseClient<Database>;

export interface DialogStaff {
  id: string;
  full_name: string;
  role: string;
}

/** A job's PO line as the dialog's cost-centre picker lists it — names only, never an amount. */
export interface DialogCostCenter {
  id: string;
  name: string;
  code: string | null;
  po_number?: string;
  cost_centre_id: string | null;
}

type PoLike = {
  po_number?: string | null;
  po_cost_centers?: { id: string; name: string; code?: string | null; cost_centre_id?: string | null }[] | null;
};

/**
 * Every cost centre (stage) across a job's POs, flat — what Time, Expenses and
 * the Schedule dialog tag against.
 */
export function costCentersFromPurchaseOrders(pos: readonly PoLike[]): DialogCostCenter[] {
  return pos.flatMap((po) =>
    (po.po_cost_centers ?? []).map((cc) => ({
      id: cc.id,
      name: cc.name,
      code: cc.code ?? null,
      po_number: po.po_number ?? undefined,
      cost_centre_id: cc.cost_centre_id ?? null,
    })),
  );
}

type JobWindow = Parameters<typeof bookingsFromJobWindow>[0];

/**
 * The bookings the dialog opens with. Without the bookings table (a database
 * without 0079) they are derived from the job's own window and crew — what
 * 0079's conversion would create — named, and read-only.
 */
export function bookingsForScheduleDialog(input: {
  bookingsReady: boolean;
  loaded: JobBookingWithNames[];
  job: JobWindow;
  crew: readonly string[];
  staff: readonly { id: string; full_name: string }[];
  purchaseOrders: readonly PoLike[];
}): JobBookingWithNames[] {
  if (input.bookingsReady) return input.loaded;
  const names = new Map(
    input.purchaseOrders.flatMap((po) => (po.po_cost_centers ?? []).map((cc) => [cc.id, cc.name] as [string, string])),
  );
  return nameBookings(bookingsFromJobWindow(input.job, input.crew), input.staff, names);
}

/**
 * The staff list plus anyone in `staffIds` who isn't in it (they've left —
 * the list is active staff only), flagged "(inactive)", so a booking or
 * assignment of theirs shows a name rather than an id.
 */
export async function appendInactiveStaff<S extends DialogStaff>(
  supabase: Client,
  staff: readonly S[],
  staffIds: readonly (string | null | undefined)[],
): Promise<DialogStaff[]> {
  const known = new Set(staff.map((s) => s.id));
  const missing = [...new Set(staffIds.filter((id): id is string => !!id && !known.has(id)))];
  if (missing.length === 0) return [...staff];
  const { data } = await supabase.from("profiles").select("id, full_name, role").in("id", missing);
  if (!data) return [...staff];
  return [...staff, ...data.map((p) => ({ id: p.id, full_name: `${p.full_name} (inactive)`, role: p.role ?? "" }))];
}

/** The job columns the dialog reads — no money. */
const DIALOG_JOB_COLUMNS =
  "id, job_number, title, status, scheduled_start, scheduled_end, schedule_daily, schedule_all_day, scheduled_cost_center_id, assigned_to";

export interface ScheduleDialogJob {
  id: string;
  job_number: number;
  title: string;
  status: string;
  scheduled_cost_center_id: string | null;
}

export type ScheduleDialogData = {
  job: ScheduleDialogJob;
  staff: DialogStaff[];
  costCenters: DialogCostCenter[];
  bookings: JobBookingWithNames[];
  bookingsReady: boolean;
};

/**
 * The job's PO lines for the picker: number and line names only. Office/admin
 * read purchase_orders (the board offers this to them alone); the amounts are
 * never selected.
 */
export async function loadJobCostCenters(supabase: Client, jobId: string): Promise<{ pos: PoLike[]; costCenters: DialogCostCenter[] }> {
  const { data } = await supabase
    .from("purchase_orders")
    .select("po_number, po_cost_centers(id, name, code, cost_centre_id)")
    .eq("job_id", jobId)
    .order("created_at");
  const pos = (data ?? []) as unknown as PoLike[];
  return { pos, costCenters: costCentersFromPurchaseOrders(pos) };
}

/**
 * Everything the Schedule dialog needs for one job, read in the browser (the
 * board). The job page reads the same pieces on the server with its other
 * data and runs them through the same helpers above.
 */
export async function loadScheduleDialogData(
  supabase: Client,
  jobId: string,
  activeStaff: readonly DialogStaff[],
): Promise<{ ok: true; data: ScheduleDialogData } | { ok: false; error: string }> {
  const [jobRes, assignRes, poRes] = await Promise.all([
    supabase.from("jobs").select(DIALOG_JOB_COLUMNS).eq("id", jobId).maybeSingle(),
    supabase.from("job_assignments").select("staff_id").eq("job_id", jobId),
    loadJobCostCenters(supabase, jobId),
  ]);
  const job = jobRes.data as unknown as (JobWindow & ScheduleDialogJob & { assigned_to: string | null }) | null;
  if (jobRes.error || !job) return { ok: false, error: "Couldn't load that job. Try again." };
  // 0079 makes the crew exactly the booked technicians, so everyone booked is named.
  const crew = (assignRes.data ?? []).map((a) => a.staff_id).filter((id): id is string => !!id);
  if (crew.length === 0 && job.assigned_to) crew.push(job.assigned_to);
  const staff = await appendInactiveStaff(supabase, activeStaff, crew);
  const loaded = await loadJobBookings(supabase, jobId, staff);
  if (loaded.error && !loaded.missingTable) return { ok: false, error: "Couldn't load the job's bookings. Try again." };
  const bookingsReady = !loaded.missingTable;
  return {
    ok: true,
    data: {
      job: {
        id: job.id,
        job_number: job.job_number,
        title: job.title,
        status: job.status,
        scheduled_cost_center_id: job.scheduled_cost_center_id ?? null,
      },
      staff,
      costCenters: poRes.costCenters,
      bookings: bookingsForScheduleDialog({ bookingsReady, loaded: loaded.bookings, job, crew, staff, purchaseOrders: poRes.pos }),
      bookingsReady,
    },
  };
}
