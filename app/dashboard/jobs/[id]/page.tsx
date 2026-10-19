export const dynamic = "force-dynamic";

import { createClient } from "@/lib/supabase/server";
import { getViewer } from "@/lib/auth/viewer";
import { notFound } from "next/navigation";
import { JobDetailClient } from "@/components/job/job-detail-client";
import { TIME_ENTRY_SELECT_WITH_STAFF } from "@/lib/time-entry-columns";
import { sumAllocatedHours } from "@/lib/hours-scoreboard";
import { loadJobBookings } from "@/lib/bookings";

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
  const staffForDisplayPromise = Promise.all([staffPromise, jobAssignmentsPromise]).then(
    async ([{ data: staff }, { data: jobAssignments }]) => {
      const staffForDisplay = staff ?? [];
      const currentAssignedIds = (jobAssignments ?? []).map((a: { staff_id: string }) => a.staff_id);
      const missingAssignedIds = currentAssignedIds.filter((sid: string) => !staffForDisplay.some((s: any) => s.id === sid));
      if (missingAssignedIds.length === 0) return staffForDisplay;
      const { data: assignedProfiles } = await supabase
        .from("profiles")
        .select("id, full_name, role")
        .in("id", missingAssignedIds);
      if (!assignedProfiles) return staffForDisplay;
      return [
        ...staffForDisplay,
        ...assignedProfiles.map((p) => ({ ...p, full_name: `${p.full_name} (inactive)` })),
      ];
    },
  );

  // The job's bookings (each technician's own time and cost centre), named
  // from the staff list above — so chained off it, alongside the main batch.
  // job_bookings is from 0079, a draft not applied yet: on a database without
  // it `missingTable` is set and the client derives the list from the job's
  // own window instead.
  const bookingsPromise = staffForDisplayPromise.then((staffList) => loadJobBookings(supabase, id, staffList));

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
    let minMarginPct = 30;
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
  ] = await Promise.all([
    // Only per-job rows load here. The shared catalogs (pricing_items,
    // variation_types, equipment) are fetched by JobDetailClient the first
    // time the tab that reads them is opened — most visits never do.
    supabase.from("jobs").select("*, customers(id, name, phone, mobile, email), sites(name, address_line1, suburb, state, postcode, site_lat, site_lng)").eq("id", id).single(),
    supabase.from("job_photos").select("*, profiles(full_name)").eq("job_id", id).order("created_at", { ascending: false }),
    supabase.from("job_documents").select("*, profiles(full_name)").eq("job_id", id).order("created_at", { ascending: false }),
    supabase.from("job_notes").select("*, profiles(full_name)").eq("job_id", id).order("created_at", { ascending: false }),
    supabase.from("job_stage_notes").select("*, profiles(full_name)").eq("job_id", id).order("created_at", { ascending: false }),
    supabase.from("job_items").select("*").eq("job_id", id).order("created_at"),
    supabase.from("purchase_orders").select("*, po_cost_centers(*)").eq("job_id", id).order("created_at"),
    supabase.from("vendor_orders").select("*").eq("job_id", id).order("created_at", { ascending: false }),
    // time_entries has two FKs to profiles (staff_id, edited_by), so an
    // unhinted "profiles(...)" embed is ambiguous and PostgREST rejects the
    // whole query (PGRST201) — naming the exact FK fixes it (see
    // app/dashboard/page.tsx for the same class of bug on "jobs").
    supabase.from("time_entries").select(TIME_ENTRY_SELECT_WITH_STAFF).eq("job_id", id).order("clock_in", { ascending: false }),
    supabase.from("job_variations").select("*, variation_types(name), profiles!job_variations_logged_by_fkey(full_name)").eq("job_id", id).order("created_at", { ascending: false }),
    supabase.from("job_expenses").select("*").eq("job_id", id).order("created_at", { ascending: false }),
    supabase.from("equipment_usage_log").select("*").eq("job_id", id).order("usage_date", { ascending: false }),
    jobAssignmentsPromise,
    staffForDisplayPromise,
    bookingsPromise,
    roleDataPromise,
  ]);

  if (!job) notFound();

  const currentAssignedIds = (jobAssignments ?? []).map((a: { staff_id: string }) => a.staff_id);

  return (
    <JobDetailClient
      job={job}
      currentUserId={user!.id}
      photos={photos ?? []}
      documents={documents ?? []}
      notes={notes ?? []}
      stageNotes={stageNotes ?? []}
      lineItems={lineItems ?? []}
      staff={staffForDisplay}
      purchaseOrders={purchaseOrders ?? []}
      vendorOrders={vendorOrders ?? []}
      timeEntries={timeEntries ?? []}
      variations={variations ?? []}
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
      bookings={bookingsResult.bookings}
      bookingsReady={!bookingsResult.missingTable}
      bookingsError={bookingsResult.missingTable ? null : bookingsResult.error}
    />
  );
}
