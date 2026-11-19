import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/monitoring";
import { dateKeyInBusinessTZ } from "@/lib/date";
import { businessDayRange } from "@/lib/scheduling";
import { BOOKING_COLUMNS, isBookingsTableMissing } from "@/lib/bookings";
import { LOAD_SELECT, MISSING, loadCartageLists, loadRowsOf } from "@/lib/cartage-load";
import { buildTruckLoadsView, siteLabelOf } from "@/lib/cartage-view";
import { defaultBilling, type LoadBilling, type LoadDirection } from "@/lib/cartage-pricing";
import { cartageSlotsToday, runJobOrder, runTotals, type RunBooking, type RunLine } from "@/lib/todays-run";

// "Today's run" — a truck driver's run sheet (19 Nov 2026; no migration).
// The phone's run screen: every job the CALLER is carting for today (their own
// cartage bookings — lib/todays-run.ts says which count), today's loads on
// each, and the lists the load form needs. Logging and signing still go
// through /api/jobs/[id]/cartage-loads (caller's client, RLS + 0111's lock);
// this route only reads.
//
// Reads, and why each client:
//   • job_bookings, jobs, job_assignments, cartage_loads — the CALLER's
//     client, so RLS decides (0107: bookings on jobs you are on; 0111: loads
//     on jobs you are on). Only the caller's own bookings are asked for.
//   • po_cost_centers — SERVICE ROLE, because it is office/admin only by RLS
//     (it carries the job's money). Read ONLY for the cost-centre ids on the
//     caller's own bookings (just read under RLS), and only `id, name` and
//     the company cost centre's `name` — never an amount. That is what tells
//     a cartage booking apart, and names the stage on the card.
//   • equipment / suppliers / cost_centres — SERVICE ROLE through
//     loadCartageLists(), as the job's Truck loads section does; passed
//     through buildTruckLoadsView with isOffice = false, which copies names
//     only.
//
// THE MONEY RULE (HANDOVER §2): this answer carries no rate, cost, margin or
// price for ANYONE — the run sheet is quantities. The office sees prices on
// the job's own Truck loads section. tests/unit/todays-run-route.test.ts
// walks the payload.
//
// Before 0111 is applied: { ready: false } with how many cartage jobs are
// booked today, never an error.
//
// `?summary=1` (My Jobs' "Today's run (N jobs)" card): only the count of open
// jobs the caller is booked on for cartage today — no loads, no lists.

const CLOSED = new Set(["completed", "cancelled"]);

type Site = { name: string | null; address_line1: string | null; suburb: string | null; state: string | null; site_lat: number | null; site_lng: number | null };
type JobRow = {
  id: string;
  job_number: number;
  title: string | null;
  status: string;
  quarry_included?: boolean | null;
  customers: { name: string | null } | null;
  sites: Site | null;
};

const JOB_COLUMNS = "id, job_number, title, status, quarry_included, customers(name), sites(name, address_line1, suburb, state, site_lat, site_lng)";
const OTHER_JOB_COLUMNS = "id, job_number, title, status, quarry_included, customers(name), sites(name, address_line1, suburb)";

export async function GET(request: NextRequest) {
  const guard = await requireRole(request, ["admin", "office", "technician"]);
  if (!guard.ok) return guard.response;
  const userId = guard.userId;

  try {
    const supabase = await callerClient(request);
    const today = dateKeyInBusinessTZ(new Date());
    const { dayStartIso, dayEndIso } = businessDayRange(today);

    // 1. The caller's own bookings that can touch today (narrowed by the day rules below).
    const bookingsRes = await supabase
      .from("job_bookings")
      .select(BOOKING_COLUMNS)
      .eq("staff_id", userId)
      .lt("starts_at", dayEndIso)
      .or(`ends_at.gte.${dayStartIso},ends_at.is.null`);
    if (bookingsRes.error && !isBookingsTableMissing(bookingsRes.error)) throw bookingsRes.error;
    const bookings = (bookingsRes.error ? [] : bookingsRes.data ?? []) as RunBooking[];

    // 2. Their cost centres (service role — see above; ids from the caller's own bookings only).
    const lineIds = [...new Set(bookings.map((b) => b.cost_center_id).filter((id): id is string => !!id))];
    const lines = new Map<string, RunLine>();
    if (lineIds.length > 0) {
      const { data, error } = await createAdminClient().from("po_cost_centers").select("id, name, cost_centres(name)").in("id", lineIds);
      if (error) throw error;
      for (const l of (data ?? []) as unknown as { id: string; name: string | null; cost_centres: { name: string | null } | null }[]) {
        lines.set(l.id, { id: l.id, name: l.name, costCentre: l.cost_centres?.name ?? null });
      }
    }
    const slots = cartageSlotsToday(bookings, lines, userId, today);
    const bookedJobIds = [...new Set(slots.map((s) => s.jobId))];

    if (request.nextUrl.searchParams.get("summary") === "1") {
      let jobCount = 0;
      if (bookedJobIds.length > 0) {
        const { data, error } = await supabase.from("jobs").select("id, status").in("id", bookedJobIds);
        if (error) throw error;
        jobCount = ((data ?? []) as { id: string; status: string }[]).filter((j) => !CLOSED.has(j.status)).length;
      }
      return NextResponse.json({ ready: true, date: today, jobCount });
    }

    // 3. Today's loads (caller's client: RLS keeps them to jobs the caller is on).
    const loadsRes = await supabase.from("cartage_loads").select(LOAD_SELECT).eq("load_date", today).order("created_at", { ascending: true });
    if (loadsRes.error && MISSING.has(loadsRes.error.code ?? "")) {
      return NextResponse.json({ ready: false, date: today, jobCount: bookedJobIds.length });
    }
    if (loadsRes.error) throw loadsRes.error;
    // On a booked job, every load today (the whole crew's); elsewhere, the caller's own — a job they added to the run.
    const allLoads = loadRowsOf(loadsRes.data).filter((l) => bookedJobIds.includes(l.job_id) || l.created_by === userId);
    const loggedJobIds = [...new Set(allLoads.filter((l) => !bookedJobIds.includes(l.job_id)).map((l) => l.job_id))];

    // 4. The jobs (caller's client).
    const runIds = [...bookedJobIds, ...loggedJobIds];
    const jobs = new Map<string, JobRow>();
    if (runIds.length > 0) {
      const { data, error } = await supabase.from("jobs").select(JOB_COLUMNS).in("id", runIds);
      if (error) throw error;
      for (const j of (data ?? []) as unknown as JobRow[]) jobs.set(j.id, j);
    }
    const jobNumber = (id: string) => jobs.get(id)?.job_number ?? Number.MAX_SAFE_INTEGER;
    const order = runJobOrder(slots, loggedJobIds, jobNumber).filter(({ jobId, booked }) => {
      const job = jobs.get(jobId);
      // A closed job stays only while it has loads today (they are still the day's work).
      return !!job && (!booked || !CLOSED.has(job.status) || allLoads.some((l) => l.job_id === jobId));
    });

    // 5. Lists for the load form (service role, names only after buildTruckLoadsView).
    const lists = await loadCartageLists();

    const runJobs = order.map(({ jobId, booked }) => {
      const job = jobs.get(jobId)!;
      const jobLoads = allLoads.filter((l) => l.job_id === jobId);
      const siteLabel = siteLabelOf(job.sites);
      const view = buildTruckLoadsView({
        isOffice: false,
        trucks: lists.trucks,
        suppliers: [],
        loads: jobLoads,
        quarryIncluded: job.quarry_included ?? null,
        siteLabel,
        costCentreNames: lists.costCentreNames,
        signatureUrls: new Map(),
      });
      return {
        id: job.id,
        jobNumber: job.job_number,
        title: job.title ?? "",
        status: job.status,
        customer: job.customers?.name ?? null,
        site: job.sites
          ? { address_line1: job.sites.address_line1, suburb: job.sites.suburb, state: job.sites.state, site_lat: job.sites.site_lat, site_lng: job.sites.site_lng }
          : null,
        siteLabel,
        booked,
        slots: slots
          .filter((s) => s.jobId === jobId)
          .map((s) => ({ bookingId: s.bookingId, startIso: s.startIso, endIso: s.endIso, allDay: s.allDay, costCentre: s.costCentre, stage: s.stage })),
        quarryIncluded: view.quarryIncluded,
        defaults: view.defaults,
        loads: view.loads,
        totals: runTotals(view.loads),
      };
    });

    // 6. "+ Add a job": the caller's own open jobs (lead or crew) not already on the run.
    const [leadRes, crewRes] = await Promise.all([
      supabase.from("jobs").select(OTHER_JOB_COLUMNS).eq("assigned_to", userId).not("status", "in", "(completed,cancelled)").order("job_number", { ascending: false }).limit(200),
      supabase
        .from("jobs")
        .select(`${OTHER_JOB_COLUMNS}, job_assignments!inner(staff_id)`)
        .eq("job_assignments.staff_id", userId)
        .not("status", "in", "(completed,cancelled)")
        .order("job_number", { ascending: false })
        .limit(200),
    ]);
    if (leadRes.error) throw leadRes.error;
    if (crewRes.error) throw crewRes.error;
    const onRun = new Set(runJobs.map((j) => j.id));
    const others = new Map<
      string,
      { id: string; jobNumber: number; title: string; customer: string | null; siteLabel: string | null; quarryIncluded: boolean | null; defaults: Record<LoadDirection, LoadBilling> }
    >();
    for (const j of [...(leadRes.data ?? []), ...(crewRes.data ?? [])] as unknown as JobRow[]) {
      if (onRun.has(j.id) || others.has(j.id)) continue;
      const quarryIncluded = j.quarry_included ?? null;
      others.set(j.id, {
        id: j.id,
        jobNumber: j.job_number,
        title: j.title ?? "",
        customer: j.customers?.name ?? null,
        siteLabel: siteLabelOf(j.sites),
        quarryIncluded,
        defaults: { material_in: defaultBilling("material_in", quarryIncluded), spoil_out: defaultBilling("spoil_out", quarryIncluded) },
      });
    }

    return NextResponse.json({
      ready: true,
      date: today,
      // Names only — never a rate (buildTruckLoadsView with isOffice false).
      trucks: buildTruckLoadsView({
        isOffice: false,
        trucks: lists.trucks,
        suppliers: lists.suppliers,
        loads: [],
        quarryIncluded: null,
        siteLabel: null,
        costCentreNames: lists.costCentreNames,
        signatureUrls: new Map(),
      }).trucks,
      suppliers: lists.suppliers.map((s) => ({ id: s.id, name: s.name, pinOrder: s.pin_order ?? null })),
      jobs: runJobs,
      totals: runTotals(runJobs.flatMap((j) => j.loads)),
      otherJobs: [...others.values()].sort((a, b) => b.jobNumber - a.jobNumber),
    });
  } catch (err) {
    console.error("today's run error:", err);
    reportError(err, { route: "api/runs/today" });
    return NextResponse.json({ error: "Couldn't load today's run. Try again." }, { status: 500 });
  }
}
