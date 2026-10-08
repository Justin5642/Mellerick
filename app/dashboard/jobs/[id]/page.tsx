export const dynamic = "force-dynamic";

import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { JobDetailClient } from "@/components/job/job-detail-client";
import { TIME_ENTRY_SELECT_WITH_STAFF } from "@/lib/time-entry-columns";

export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const [
    { data: job },
    { data: { user } },
    { data: photos },
    { data: documents },
    { data: notes },
    { data: stageNotes },
    { data: lineItems },
    { data: pricingItems },
    { data: staff },
    { data: purchaseOrders },
    { data: vendorOrders },
    { data: timeEntries },
    { data: variations },
    { data: variationTypes },
    { data: expenses },
    { data: equipmentOptions },
    { data: equipmentUsage },
    { data: jobAssignments },
  ] = await Promise.all([
    supabase.from("jobs").select("*, customers(id, name, phone, mobile, email), sites(name, address_line1, suburb, state, postcode, site_lat, site_lng)").eq("id", id).single(),
    supabase.auth.getUser(),
    supabase.from("job_photos").select("*, profiles(full_name)").eq("job_id", id).order("created_at", { ascending: false }),
    supabase.from("job_documents").select("*, profiles(full_name)").eq("job_id", id).order("created_at", { ascending: false }),
    supabase.from("job_notes").select("*, profiles(full_name)").eq("job_id", id).order("created_at", { ascending: false }),
    supabase.from("job_stage_notes").select("*, profiles(full_name)").eq("job_id", id).order("created_at", { ascending: false }),
    supabase.from("job_items").select("*").eq("job_id", id).order("created_at"),
    supabase.from("pricing_items").select("*").eq("is_active", true).order("category").order("name"),
    supabase.from("profiles").select("id, full_name, role").eq("is_active", true).order("full_name"),
    supabase.from("purchase_orders").select("*, po_cost_centers(*)").eq("job_id", id).order("created_at"),
    supabase.from("vendor_orders").select("*").eq("job_id", id).order("created_at", { ascending: false }),
    // time_entries has two FKs to profiles (staff_id, edited_by), so an
    // unhinted "profiles(...)" embed is ambiguous and PostgREST rejects the
    // whole query (PGRST201) — naming the exact FK fixes it (see
    // app/dashboard/page.tsx for the same class of bug on "jobs").
    supabase.from("time_entries").select(TIME_ENTRY_SELECT_WITH_STAFF).eq("job_id", id).order("clock_in", { ascending: false }),
    supabase.from("job_variations").select("*, variation_types(name), profiles!job_variations_logged_by_fkey(full_name)").eq("job_id", id).order("created_at", { ascending: false }),
    supabase.from("variation_types").select("*").eq("is_active", true).order("name"),
    supabase.from("job_expenses").select("*").eq("job_id", id).order("created_at", { ascending: false }),
    supabase.from("equipment").select("*").eq("is_active", true).order("name"),
    supabase.from("equipment_usage_log").select("*").eq("job_id", id).order("usage_date", { ascending: false }),
    supabase.from("job_assignments").select("staff_id").eq("job_id", id),
  ]);

  if (!job) notFound();

  const currentAssignedIds = (jobAssignments ?? []).map((a: { staff_id: string }) => a.staff_id);

  // The staff list above only includes active profiles (so you can't assign
  // new work to someone who's left), but a job can already be assigned to
  // someone who's since been deactivated. The assignment dialog renders each
  // technician's name by matching their id against this list, so if they're
  // missing from it entirely it falls back to showing the raw profile id
  // instead of their name. Fetch and append any such profile (flagged) so
  // every current assignment always displays correctly.
  let staffForDisplay = staff ?? [];
  const missingAssignedIds = currentAssignedIds.filter((sid: string) => !staffForDisplay.some((s: any) => s.id === sid));
  if (missingAssignedIds.length > 0) {
    const { data: assignedProfiles } = await supabase
      .from("profiles")
      .select("id, full_name, role")
      .in("id", missingAssignedIds);
    if (assignedProfiles) {
      staffForDisplay = [
        ...staffForDisplay,
        ...assignedProfiles.map((p) => ({ ...p, full_name: `${p.full_name} (inactive)` })),
      ];
    }
  }

  // The "Costing" tab folds in staff_cost_profiles (payroll-sensitive), so
  // it's only fetched and rendered for admins — same gating pattern as the
  // Reports page's staff efficiency section.
  let isAdmin = false;
  let isOffice = false;
  let staffCostProfiles: any[] = [];
  let jobInvoices: any[] = [];
  let minMarginPct = 30;
  if (user) {
    const { data: viewerProfile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
    isAdmin = viewerProfile?.role === "admin";
    isOffice = isAdmin || viewerProfile?.role === "office";
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

  return (
    <JobDetailClient
      job={job}
      currentUserId={user!.id}
      photos={photos ?? []}
      documents={documents ?? []}
      notes={notes ?? []}
      stageNotes={stageNotes ?? []}
      lineItems={lineItems ?? []}
      pricingItems={pricingItems ?? []}
      staff={staffForDisplay}
      purchaseOrders={purchaseOrders ?? []}
      vendorOrders={vendorOrders ?? []}
      timeEntries={timeEntries ?? []}
      variations={variations ?? []}
      variationTypes={variationTypes ?? []}
      expenses={expenses ?? []}
      equipmentOptions={equipmentOptions ?? []}
      equipmentUsage={equipmentUsage ?? []}
      isAdmin={isAdmin}
      isOffice={isOffice}
      staffCostProfiles={staffCostProfiles}
      jobInvoices={jobInvoices}
      minMarginPct={minMarginPct}
      currentAssignedIds={currentAssignedIds}
    />
  );
}
