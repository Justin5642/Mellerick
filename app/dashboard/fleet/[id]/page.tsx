export const dynamic = "force-dynamic";

import { getViewer } from "@/lib/auth/viewer";
import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { EquipmentDetailClient } from "@/components/fleet/equipment-detail-client";
import { attachEffectiveRates } from "@/lib/fleet-rates";
import { dateKeyInBusinessTZ } from "@/lib/date";
import { isServiceTableMissing, type ServiceRecord } from "@/lib/service-due";

export default async function EquipmentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const [
    { data: equipment },
    viewer,
    { data: documents },
    { data: expenses },
    { data: usage },
    { data: staff },
    servicesRes,
  ] = await Promise.all([
    supabase.from("equipment").select("*").eq("id", id).single(),
    getViewer(),
    supabase.from("equipment_documents").select("*, profiles(full_name)").eq("equipment_id", id).order("created_at", { ascending: false }),
    supabase.from("equipment_expenses").select("*").eq("equipment_id", id).order("expense_date", { ascending: false }),
    supabase.from("equipment_usage_log").select("*, jobs(job_number, title)").eq("equipment_id", id).order("usage_date", { ascending: false }),
    supabase.from("profiles").select("id, full_name, role").eq("is_active", true).order("full_name"),
    supabase.from("equipment_service_records").select("*").eq("equipment_id", id).order("service_date", { ascending: false }),
  ]);

  if (!equipment) notFound();

  // The rate job costing uses for this machine: actual over the last 12
  // months once there is enough logged, else the estimate (lib/fleet-costs.ts).
  const today = dateKeyInBusinessTZ(new Date());
  const [withRate] = await attachEffectiveRates(supabase as any, [equipment as any], today);

  // Service records need 0099 (draft, not applied yet). Without it the tab says so; any other read
  // failure is logged and shown the same way rather than taking the page down.
  if (servicesRes.error && !isServiceTableMissing(servicesRes.error)) console.error("fleet: service records unavailable", servicesRes.error);
  const services = servicesRes.error ? null : ((servicesRes.data ?? []) as ServiceRecord[]);

  let isAdmin = false;
  const user = viewer?.user;
  if (user) {
    isAdmin = viewer?.profile?.role === "admin";
  }

  return (
    <EquipmentDetailClient
      equipment={withRate}
      today={today}
      services={services}
      canEditServices={viewer?.profile?.role === "admin" || viewer?.profile?.role === "office"}
      currentUserId={user!.id}
      isAdmin={isAdmin}
      documents={documents ?? []}
      expenses={expenses ?? []}
      usage={usage ?? []}
      staff={staff ?? []}
    />
  );
}
