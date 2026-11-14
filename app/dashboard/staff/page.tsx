export const dynamic = "force-dynamic";

import { getViewer } from "@/lib/auth/viewer";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { StaffClient } from "@/components/staff/staff-client";
import type { AutoClockStatusRow } from "@/lib/auto-clock-status";

export default async function StaffPage() {
  const supabase = await createClient();

  // One parallel batch on the server, the viewer's role included — this used
  // to run in the browser after hydration and then look the role up in a
  // second, sequential round trip. Profile columns are the ones the roster
  // renders (StaffClient re-reads the same set after an invite).
  const [viewer, { data: staff, error }, { data: vehicles }, statusRes] = await Promise.all([
    getViewer(),
    supabase.from("profiles").select("id, full_name, email, phone, role, is_active, auto_clock").order("full_name"),
    supabase.from("equipment").select("id, name, assigned_to").not("assigned_to", "is", null),
    // What each phone says about its auto clock (0102 — draft, not applied
    // yet). Missing table or any error: the column just isn't shown.
    supabase.from("auto_clock_status").select("*"),
  ]);
  const autoClockStatus = statusRes.error
    ? null
    : Object.fromEntries(((statusRes.data ?? []) as AutoClockStatusRow[]).map((r) => [r.staff_id, r]));

  if (!viewer) redirect("/login");

  return (
    <StaffClient
      role={viewer.profile?.role ?? null}
      staff={staff ?? []}
      vehicles={vehicles ?? []}
      autoClockStatus={autoClockStatus}
      fetchError={error?.message ?? null}
    />
  );
}
