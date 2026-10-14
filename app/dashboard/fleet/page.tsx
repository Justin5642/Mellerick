export const dynamic = "force-dynamic";

import { getViewer } from "@/lib/auth/viewer";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { FleetClient } from "@/components/fleet/fleet-client";

export default async function FleetPage() {
  const supabase = await createClient();

  // One parallel batch on the server, the viewer's role included — this used
  // to run in the browser after hydration and then look the role up in a
  // second, sequential round trip. equipment stays "*": a small table, and
  // computeEquipmentCost reads most of its columns.
  const [viewer, { data: equipment, error }, { data: staff }] = await Promise.all([
    getViewer(),
    supabase.from("equipment").select("*").order("name"),
    supabase.from("profiles").select("id, full_name, role").eq("is_active", true).order("full_name"),
  ]);

  if (!viewer) redirect("/login");

  return (
    <FleetClient
      role={viewer.profile?.role ?? null}
      currentUserId={viewer.user.id}
      equipment={equipment ?? []}
      staff={staff ?? []}
      fetchError={error?.message ?? null}
    />
  );
}
