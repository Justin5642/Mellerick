export const dynamic = "force-dynamic";

import { createClient } from "@/lib/supabase/server";
import { getViewer } from "@/lib/auth/viewer";
import { notFound } from "next/navigation";
import { JobDetailClient } from "@/components/job/job-detail-client";
import { TIME_ENTRY_SELECT_WITH_STAFF, TIME_ENTRY_SELECT_WITH_STAFF_AND_VARIATION, withVariationFallback } from "@/lib/time-entry-columns";
import { sumAllocatedHours } from "@/lib/hours-scoreboard";
import { loadJobBookings } from "@/lib/bookings";
import { loadScheduleLeave } from "@/lib/staff-leave-data";
import { dateKeyInBusinessTZ, shiftDateKey } from "@/lib/date";
import { loadTechVariations } from "@/lib/variations-public";
import { appendInactiveStaff } from "@/lib/schedule-dialog-data";

export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  // A Supabase query builder sends its request each time it is awaited, so the
  // two reads the inactive-profile lookup depends on are turned into plain
  // promises once and shared with the main batch below.
  const staffPromise = Promise.resolve(
    supabase.from("profiles").select("id, full_name, role").eq("is_active", true).order("full_name"),
  );
  const jobAssignmentsPromise = Promise.resolve(
    supabase.from("job_assignments").select("staff_id").eq("job_id", id),
  );

  // The staff list above only includes active profiles (so you can't assign
  // new work to someone who's left), but a job can already be assigned to
  // someone who's since been deactivated. The assignment dialog renders each
  // technician's name by matching their id against this list, so if they're
  // missing from it entirely it falls back to showing the raw profile id
  // instead of their name. Fetch and append any such profile (flagged) so
  // every current assignment always displays correctly. Chained off just those
  // two reads, so it no longer waits for the whole batch.
  const staffForDisplayPromise = Promise.all([staffPromise, jobAssignmentsPromise]).then(([{ data: staff }, { data: jobAssignments }]) =>
    appendInactiveStaff(supabase, staff ?? [], (jobAssignments ?? []).map((a: { staff_id: string }) => a.staff_id)),
  );

  // The job's bookings (each technician's own time and cost centre), named
  // from the staff list above — so chained off it, alongside the main batch.
  // job_bookings is from 0079 yet: on a database without
  // it `missingTable` is set and the client derives the list from the job's
  // own window instead.
  const bookingsPromise = staffForDisplayPromise.then((staffList) => loadJobBookings(supabase, id, staffList));
  // Staff leave from today for a year (0112 — a draft, not applied yet, schedule_leave()): a booking on
  // someone's leave day is flagged "Needs reassigning". The type comes back
  // only for whoever the setting allows. [] before 0112.
  const leaveToday = dateKeyInBusinessTZ(new Date());
  const leavePromise = loadScheduleLeave(supabase, leaveToday, shiftDateKey(leaveToday, 366));

  // Role-dependent reads, chained off the viewer alone so they run alongside
  // the main batch instead of after it. The role gates are unchanged: a
  // technician never issues the admin batch, and office/admin never read
  // purchase_orders_public.
  const roleDataPromise = getViewer().then(async (viewer) => {
    // The "Costing" tab folds in staff_cost_profiles (payroll-sensitive), so
    // it's only fetched and rendered for admins — same gating pattern as the
    // Reports page's staff efficiency section.
    let isAdmin = false;
    let isOffice = false;
    let staffCostProfiles: any[] = [];
    let jobInvoices: any[] = [];
    let minMarginPct = 20;
    const user = viewer?.user;
    if (user) {
      // Role comes from the per-request cached viewer (lib/auth/viewer.ts), not
      // another profiles round trip.
      isAdmin = viewer?.profile?.role === "admin";
      isOffice = isAdmin || viewer?.profile?.role === "office";
    }
    // Technicians get the Hours Scoreboard on Overview instead of the PO tab.
    // `purchase_orders` (main batch) is office/admin-only under RLS (0038) and
    // returns no rows to a tech, so their allocation comes from the money-free
    // `purchase_orders_public` view — hours only, never total_value. Do not widen
    // this select. Office/admin keep the base-table read and the PO tab.
    let techAllocatedHours = 0;
    let techAllocatedHoursError: string | null = null;
    if (user && !isOffice) {
      const { data: publicPos, error: publicPosError } = await supabase
        .from("purchase_orders_public")
        .select("total_hours")
        .eq("job_id", id);
      if (publicPosError) techAllocatedHoursError = publicPosError.message;
      else techAllocatedHours = sumAllocatedHours(publicPos ?? []);
    }

    if (isAdmin) {
      const [{ data: costProfiles }, { data: invoicesForJob }, { data: rateConfig }] = await Promise.all([
        supabase.from("staff_cost_profiles").select("*"),
        supabase.from("invoices").select("id, subtotal, status").eq("job_id", id),
        supabase.from("billing_rate_config").select("min_margin_pct").eq("id", true).maybeSingle(),
      ]);
      staffCostProfiles = costProfiles ?? [];
      jobInvoices = invoicesForJob ?? [];
      if (rateConfig?.min_margin_pct != null) minMarginPct = Number(rateConfig.min_margin_pct);
    }

    return { user, isAdmin, isOffice, techAllocatedHours, techAllocatedHoursError, staffCostProfiles, jobInvoices, minMarginPct };
  });

  const [
    { data: job },
    { data: photos },
    { data: documents },
    { data: notes },
    { data: stageNotes },
    { data: lineItems },
    { data: purchaseOrders },
    { data: vendorOrders },
    { data: timeEntries },
    { data: variations },
    { data: expenses },
    { data: equipmentUsage },
    { data: jobAssignments },
    staffForDisplay,
    bookingsResult,
    { user, isAdmin, isOffice, techAllocatedHours, techAllocatedHoursError, staffCostProfiles, jobInvoices, minMarginPct },
    leave,
  ] = await Promise.all([
    // Only per-job rows load here. The shared catalogs (pricing_items,
    // variation_types, equipment) are fetched by JobDetailClient the first
    // time the tab that reads them is opened — most visits never do.
    supabase.from("jobs").select("*, customers(id, name, phone, mobile, email), sites(name, address_line1, suburb, state, postcode, site_lat, site_lng, geofence_radius_m)").eq("id", id).single(),
    supabase.from("job_photos").select("*, profiles(full_name)").eq("job_id", id).order("created_at", { ascending: false }),
    supabase.from("job_documents").select("*, profiles(full_name)").eq("job_id", id).order("created_at", { ascending: false }),
    supabase.from("job_notes").select("*, profiles(full_name)").eq("job_id", id).order("created_at", { ascending: false }),
    supabase.from("job_stage_notes").select("*, profiles(full_name)").eq("job_id", id).order("created_at", { ascending: false }),
    supabase.from("job_items").select("*").eq("job_id", id).order("created_at"),
    supabase.from("purchase_orders").select("*, po_cost_centers(*)").eq("job_id", id).order("created_at"),
    supabase.from("vendor_orders").select("*, vendor_order_items(description, quantity, sort_order), profiles!vendor_orders_entered_by_fkey(full_name)").eq("job_id", id).order("created_at", { ascending: false }),
    // time_entries has two FKs to profiles (staff_id, edited_by), so an
    // unhinted "profiles(...)" embed is ambiguous and PostgREST rejects the
    // whole query (PGRST201) — naming the exact FK fixes it (see
    // app/dashboard/page.tsx for the same class of bug on "jobs").
    // With 0120 (draft)'s variation_id (time against a variation); a database without
    // it is read without, and every entry is then the stage's.
    withVariationFallback(
      (cols) =>
        supabase
          .from("time_entries")
          .select(cols as typeof TIME_ENTRY_SELECT_WITH_STAFF)
          .eq("job_id", id)
          .order("clock_in", { ascending: false }),
      { withVariation: TIME_ENTRY_SELECT_WITH_STAFF_AND_VARIATION, without: TIME_ENTRY_SELECT_WITH_STAFF }
    ),
    supabase.from("job_variations").select("*, variation_types(name), profiles!job_variations_logged_by_fkey(full_name)").eq("job_id", id).order("created_at", { ascending: false }),
    supabase.from("job_expenses").select("*").eq("job_id", id).order("created_at", { ascending: false }),
    supabase.from("equipment_usage_log").select("*").eq("job_id", id).order("usage_date", { ascending: false }),
    jobAssignmentsPromise,
    staffForDisplayPromise,
    bookingsPromise,
    roleDataPromise,
    leavePromise,
  ]);

  if (!job) notFound();

  // A technician cannot read the priced job_variations table (0028) — the
  // query above returns nothing for them — so their list comes from the
  // rate-stripped view instead.
  const visibleVariations =
    isAdmin || isOffice ? variations ?? [] : (await loadTechVariations(supabase, { jobId: id })).data;

  const currentAssignedIds = (jobAssignments ?? []).map((a: { staff_id: string }) => a.staff_id);

  // A technician may open any job to look up its plans, but on a job they are
  // not on they get no schedule (who is booked, when) and no notes (Justin,
  // 16 Nov 2026). Stripped here so none of it reaches the browser.
  const hideSchedule = !isOffice && !(user && (currentAssignedIds.includes(user.id) || job.assigned_to === user.id));
  // jobs.admin_notes is also the admin's APPROVAL comment, which can talk
  // money — a technician only gets it while the job is sent back (it is the
  // send-back note then; lib/sent-back.ts). Not on the job: no send-back at all.
  const techJob = isOffice
    ? job
    : { ...job, admin_notes: job.admin_status === "rejected" ? job.admin_notes : null };
  const shownJob = hideSchedule
    ? {
        ...techJob,
        scheduled_start: null,
        scheduled_end: null,
        schedule_daily: false,
        schedule_all_day: false,
        assigned_to: null,
        admin_status: null,
        admin_notes: null,
        sent_back_note: null,
        sent_back_at: null,
      }
    : techJob;

  return (
    <JobDetailClient
      job={shownJob}
      currentUserId={user!.id}
      photos={photos ?? []}
      documents={documents ?? []}
      notes={hideSchedule ? [] : notes ?? []}
      stageNotes={hideSchedule ? [] : stageNotes ?? []}
      lineItems={lineItems ?? []}
      staff={staffForDisplay}
      purchaseOrders={purchaseOrders ?? []}
      vendorOrders={vendorOrders ?? []}
      timeEntries={timeEntries ?? []}
      variations={visibleVariations}
      expenses={expenses ?? []}
      equipmentUsage={equipmentUsage ?? []}
      isAdmin={isAdmin}
      isOffice={isOffice}
      techAllocatedHours={techAllocatedHours}
      techAllocatedHoursError={techAllocatedHoursError}
      staffCostProfiles={staffCostProfiles}
      jobInvoices={jobInvoices}
      minMarginPct={minMarginPct}
      currentAssignedIds={currentAssignedIds}
      bookings={hideSchedule ? [] : bookingsResult.bookings}
      leave={hideSchedule ? [] : leave}
      hideSchedule={hideSchedule}
      bookingsReady={!bookingsResult.missingTable}
      bookingsError={bookingsResult.missingTable ? null : bookingsResult.error}
    />
  );
}
