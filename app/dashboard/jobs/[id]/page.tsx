export const dynamic = "force-dynamic";

import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { JobDetailClient } from "@/components/job/job-detail-client";

export default async function JobDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const [
    { data: job },
    { data: { user } },
    { data: photos },
    { data: documents },
    { data: notes },
    { data: lineItems },
    { data: pricingItems },
    { data: staff },
    { data: purchaseOrders },
    { data: timeEntries },
    { data: variations },
    { data: variationTypes },
    { data: expenses },
    { data: equipmentOptions },
    { data: equipmentUsage },
  ] = await Promise.all([
    supabase.from("jobs").select("*, customers(id, name, phone, mobile, email), sites(name, address_line1, suburb, state, postcode, site_lat, site_lng)").eq("id", id).single(),
    supabase.auth.getUser(),
    supabase.from("job_photos").select("*, profiles(full_name)").eq("job_id", id).order("created_at", { ascending: false }),
    supabase.from("job_documents").select("*, profiles(full_name)").eq("job_id", id).order("created_at", { ascending: false }),
    supabase.from("job_notes").select("*, profiles(full_name)").eq("job_id", id).order("created_at", { ascending: false }),
    supabase.from("job_items").select("*").eq("job_id", id).order("created_at"),
    supabase.from("pricing_items").select("*").eq("is_active", true).order("category").order("name"),
    supabase.from("profiles").select("id, full_name, role").eq("is_active", true).order("full_name"),
    supabase.from("purchase_orders").select("*, po_cost_centers(*)").eq("job_id", id).order("created_at"),
    // time_entries has two FKs to profiles (staff_id, edited_by), so an
    // unhinted "profiles(...)" embed is ambiguous and PostgREST rejects the
    // whole query (PGRST201) — naming the exact FK fixes it (see
    // app/dashboard/page.tsx for the same class of bug on "jobs").
    supabase.from("time_entries").select("*, profiles!time_entries_staff_id_fkey(full_name)").eq("job_id", id).order("clock_in", { ascending: false }),
    supabase.from("job_variations").select("*, variation_types(name), profiles!job_variations_logged_by_fkey(full_name)").eq("job_id", id).order("created_at", { ascending: false }),
    supabase.from("variation_types").select("*").eq("is_active", true).order("name"),
    supabase.from("job_expenses").select("*").eq("job_id", id).order("created_at", { ascending: false }),
    supabase.from("equipment").select("*").eq("is_active", true).order("name"),
    supabase.from("equipment_usage_log").select("*").eq("job_id", id).order("usage_date", { ascending: false }),
  ]);

  if (!job) notFound();

  // The staff list above only includes active profiles (so you can't assign
  // new work to someone who's left), but a job can already be assigned to
  // someone who's since been deactivated. The assignment dropdown renders
  // the technician's name by matching their id against this list, so if
  // they're missing from it entirely it falls back to showing the raw
  // profile id instead of their name. Fetch and append that one profile
  // (flagged) so the current assignment always displays correctly.
  let staffForDisplay = staff ?? [];
  if (job.assigned_to && !staffForDisplay.some((s: any) => s.id === job.assigned_to)) {
    const { data: assignedProfile } = await supabase
      .from("profiles")
      .select("id, full_name, role")
      .eq("id", job.assigned_to)
      .single();
    if (assignedProfile) {
      staffForDisplay = [...staffForDisplay, { ...assignedProfile, full_name: `${assignedProfile.full_name} (inactive)` }];
    }
  }

  // The "Costing" tab folds in staff_cost_profiles (payroll-sensitive), so
  // it's only fetched and rendered for admins — same gating pattern as the
  // Reports page's staff efficiency section.
  let isAdmin = false;
  let staffCostProfiles: any[] = [];
  let jobInvoices: any[] = [];
  let minMarginPct = 30;
  if (user) {
    const { data: viewerProfile } = await supabase.from("profiles").select("role").eq("id", user.id).single();
    isAdmin = viewerProfile?.role === "admin";
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
      lineItems={lineItems ?? []}
      pricingItems={pricingItems ?? []}
      staff={staffForDisplay}
      purchaseOrders={purchaseOrders ?? []}
      timeEntries={timeEntries ?? []}
      variations={variations ?? []}
      variationTypes={variationTypes ?? []}
      expenses={expenses ?? []}
      equipmentOptions={equipmentOptions ?? []}
      equipmentUsage={equipmentUsage ?? []}
      isAdmin={isAdmin}
      staffCostProfiles={staffCostProfiles}
      jobInvoices={jobInvoices}
      minMarginPct={minMarginPct}
    />
  );
}
