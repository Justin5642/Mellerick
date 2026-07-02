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
  ] = await Promise.all([
    supabase.from("jobs").select("*, customers(id, name, phone, mobile, email), sites(name, address_line1, suburb, state, postcode)").eq("id", id).single(),
    supabase.auth.getUser(),
    supabase.from("job_photos").select("*, profiles(full_name)").eq("job_id", id).order("created_at", { ascending: false }),
    supabase.from("job_documents").select("*, profiles(full_name)").eq("job_id", id).order("created_at", { ascending: false }),
    supabase.from("job_notes").select("*, profiles(full_name)").eq("job_id", id).order("created_at", { ascending: false }),
    supabase.from("job_items").select("*").eq("job_id", id).order("created_at"),
    supabase.from("pricing_items").select("*").eq("is_active", true).order("category").order("name"),
    supabase.from("profiles").select("id, full_name, role").eq("is_active", true).order("full_name"),
    supabase.from("purchase_orders").select("*, po_cost_centers(*)").eq("job_id", id).order("created_at"),
    supabase.from("time_entries").select("*, profiles(full_name)").eq("job_id", id).order("clock_in", { ascending: false }),
  ]);

  if (!job) notFound();

  return (
    <JobDetailClient
      job={job}
      currentUserId={user!.id}
      photos={photos ?? []}
      documents={documents ?? []}
      notes={notes ?? []}
      lineItems={lineItems ?? []}
      pricingItems={pricingItems ?? []}
      staff={staff ?? []}
      purchaseOrders={purchaseOrders ?? []}
      timeEntries={timeEntries ?? []}
    />
  );
}
