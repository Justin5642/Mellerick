export const dynamic = "force-dynamic";

import { getViewer } from "@/lib/auth/viewer";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { FleetClient } from "@/components/fleet/fleet-client";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import { attachEffectiveRates } from "@/lib/fleet-rates";
import { dateKeyInBusinessTZ } from "@/lib/date";
import type { FleetExpense } from "@/lib/fleet-costs";

export default async function FleetPage() {
  const supabase = await createClient();

  // One parallel batch on the server, the viewer's role included — this used
  // to run in the browser after hydration and then look the role up in a
  // second, sequential round trip. equipment stays "*": a small table, and
  // computeEquipmentCost reads most of its columns.
  //
  // Every expense, paged: the yearly summary lets you pick any past financial
  // year, and a truncated read would understate a year's cost without saying so.
  const [viewer, { data: equipment, error }, { data: staff }, expensesRes] = await Promise.all([
    getViewer(),
    supabase.from("equipment").select("*").order("name"),
    supabase.from("profiles").select("id, full_name, role").eq("is_active", true).order("full_name"),
    fetchAllRows<FleetExpense>((c) =>
      supabase.from("equipment_expenses").select("equipment_id, category, amount, gst_amount, expense_date", c).order("id") as never
    ),
  ]);

  if (!viewer) redirect("/login");

  const today = dateKeyInBusinessTZ(new Date());
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
      fetchError={error?.message ?? null}
    />
  );
}
