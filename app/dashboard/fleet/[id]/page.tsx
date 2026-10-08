export const dynamic = "force-dynamic";

import { getViewer } from "@/lib/auth/viewer";
import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import { EquipmentDetailClient } from "@/components/fleet/equipment-detail-client";

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
  ] = await Promise.all([
    supabase.from("equipment").select("*").eq("id", id).single(),
    getViewer(),
    supabase.from("equipment_documents").select("*, profiles(full_name)").eq("equipment_id", id).order("created_at", { ascending: false }),
    supabase.from("equipment_expenses").select("*").eq("equipment_id", id).order("expense_date", { ascending: false }),
    supabase.from("equipment_usage_log").select("*, jobs(job_number, title)").eq("equipment_id", id).order("usage_date", { ascending: false }),
    supabase.from("profiles").select("id, full_name, role").eq("is_active", true).order("full_name"),
  ]);

  if (!equipment) notFound();

  let isAdmin = false;
  const user = viewer?.user;
  if (user) {
    isAdmin = viewer?.profile?.role === "admin";
  }

  return (
    <EquipmentDetailClient
      equipment={equipment}
      currentUserId={user!.id}
      isAdmin={isAdmin}
      documents={documents ?? []}
      expenses={expenses ?? []}
      usage={usage ?? []}
      staff={staff ?? []}
    />
  );
}
