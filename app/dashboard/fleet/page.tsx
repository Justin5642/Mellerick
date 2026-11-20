export const dynamic = "force-dynamic";

import { getViewer } from "@/lib/auth/viewer";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { FleetClient } from "@/components/fleet/fleet-client";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import { attachEffectiveRates } from "@/lib/fleet-rates";
import { dateKeyInBusinessTZ } from "@/lib/date";
import type { FleetExpense } from "@/lib/fleet-costs";
import type { ServiceRecord } from "@/lib/service-due";
import type { HireOptionRow } from "@/components/fleet/equipment-hire-dialog";
import { loadKomtraxFleet } from "@/lib/komtrax-data";

export default async function FleetPage() {
  const supabase = await createClient();

  // One parallel batch on the server, the viewer's role included — this used
  // to run in the browser after hydration and then look the role up in a
  // second, sequential round trip. equipment stays "*": a small table, and
  // computeEquipmentCost reads most of its columns.
  //
  // Every expense, paged: the yearly summary lets you pick any past financial
  // year, and a truncated read would understate a year's cost without saying so.
  const [viewer, { data: equipment, error }, { data: staff }, expensesRes, servicesRes, hireOptionsRes, attachmentsRes, centresRes] = await Promise.all([
    getViewer(),
    supabase.from("equipment").select("*").order("name"),
    supabase.from("profiles").select("id, full_name, role").eq("is_active", true).order("full_name"),
    fetchAllRows<FleetExpense>((c) =>
      supabase.from("equipment_expenses").select("equipment_id, category, amount, gst_amount, expense_date", c).order("id") as never
    ),
    // For each item's next-service status. Needs 0099; without it the list
    // simply shows no service status.
    fetchAllRows<ServiceRecord>((c) =>
      supabase
        .from("equipment_service_records")
        .select("id, equipment_id, service_date, service_type, odometer_km, engine_hours, next_due_date, next_due_km, next_due_hours, created_at", c)
        .order("id") as never
    ),
    // Day Works / Hire setup (office/admin only by RLS). Before the Day Works
    // migration is applied (drafted, not yet applied) these error and the
    // hire controls stay hidden.
    supabase.from("equipment_hire_options").select("*"),
    supabase.from("hire_attachments").select("id, name, day_rate, is_active, notes").order("name"),
    supabase.from("cost_centres").select("id, name").eq("is_active", true).order("sort_order").order("name"),
  ]);

  if (!viewer) redirect("/login");

  const today = dateKeyInBusinessTZ(new Date());
  // Komtrax (0113 (draft)): office/admin only by RLS, so only asked for them.
  const role = viewer.profile?.role ?? null;
  const komtrax = role === "admin" || role === "office" ? await loadKomtraxFleet(supabase) : null;
  const withRates = await attachEffectiveRates(supabase as any, (equipment ?? []) as any[], today);

  return (
    <FleetClient
      role={viewer.profile?.role ?? null}
      currentUserId={viewer.user.id}
      equipment={withRates}
      staff={staff ?? []}
      expenses={expensesRes.ok ? expensesRes.rows : null}
      expensesError={expensesRes.ok ? null : expensesRes.error}
      today={today}
      services={servicesRes.ok ? servicesRes.rows : null}
      hireOptions={hireOptionsRes.error ? null : ((hireOptionsRes.data ?? []) as HireOptionRow[])}
      hireAttachments={attachmentsRes.error ? null : attachmentsRes.data ?? []}
      costCentres={centresRes.data ?? []}
      komtrax={komtrax}
      fetchError={error?.message ?? null}
    />
  );
}
