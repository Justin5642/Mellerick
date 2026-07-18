import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createClient as createServerClient } from "@/lib/supabase/server";
import { computeLoadedCost } from "@/lib/staff-cost";
import { computeEquipmentCost, type EquipmentCostInputs } from "@/lib/equipment-cost";
import { splitHoursByBand, computeLabourCharge, DEFAULT_LABOUR_RATE_CONFIG, type LabourRateConfig } from "@/lib/labour-billing";

// Regenerates a job's auto-generated labour line item (and, on the first
// work entry logged, its one-off call-out fee) from a single time_entries
// row. Called fire-and-forget right after any client writes/edits a time
// entry -- same "insert then fetch(/api/...)" pattern already used for
// syncing a job's Google Calendar event after it's created/updated.
//
// Uses the service-role key because job_items is now locked to
// Admin-only writes (see migration 0024) -- a technician logging their own
// hours must still be able to trigger this, so the route authenticates the
// caller itself (dual-path: mobile Bearer token or web session cookie, same
// as app/api/ai/polish-note) and then writes with elevated privileges on
// their behalf, rather than requiring the caller to be an Admin.
function getAdminClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function getAuthenticatedUserId(request: NextRequest) {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
  if (token) {
    const anonClient = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await anonClient.auth.getUser(token);
    return error || !data.user ? null : data.user.id;
  }
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  return user?.id ?? null;
}

function describeBreakdown(breakdown: ReturnType<typeof splitHoursByBand>, charge: ReturnType<typeof computeLabourCharge>) {
  const parts: string[] = [];
  if (breakdown.normalHours > 0) parts.push(`${breakdown.normalHours.toFixed(2)}h @ $${charge.ordinaryHourlyRate.toFixed(2)}/hr`);
  if (breakdown.timeAndHalfHours > 0) parts.push(`${breakdown.timeAndHalfHours.toFixed(2)}h @ $${charge.timeAndHalfHourlyRate.toFixed(2)}/hr (1.5x)`);
  if (breakdown.doubleTimeHours > 0) parts.push(`${breakdown.doubleTimeHours.toFixed(2)}h @ $${charge.doubleTimeHourlyRate.toFixed(2)}/hr (2x)`);
  return parts.join(" + ") || "0h";
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: timeEntryId } = await params;

  const callerId = await getAuthenticatedUserId(request);
  if (!callerId) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const admin = getAdminClient();

  const { data: entry, error: entryError } = await admin
    .from("time_entries")
    .select("id, job_id, staff_id, clock_in, clock_out, hours, entry_type")
    .eq("id", timeEntryId)
    .maybeSingle();

  if (entryError) return NextResponse.json({ error: entryError.message }, { status: 500 });
  if (!entry) return NextResponse.json({ error: "Time entry not found" }, { status: 404 });

  // Only actual work is billed -- travel time is covered by the flat
  // call-out fee, and an open entry (no clock_out yet) has nothing to
  // price. Clear out any stale auto_labour row for this entry (e.g. it was
  // edited from "work" to "travel") rather than leaving an orphaned charge.
  if (entry.entry_type !== "work" || !entry.clock_out) {
    await admin.from("job_items").delete().eq("time_entry_id", timeEntryId);
    return NextResponse.json({ skipped: true });
  }

  const [{ data: costProfile }, { data: rateConfigRow }] = await Promise.all([
    admin
      .from("staff_cost_profiles")
      .select("staff_id, hourly_rate, super_rate, workers_comp_rate, leave_loading_rate, annual_fixed_oncosts, target_hours_per_week, trade_level")
      .eq("staff_id", entry.staff_id)
      .maybeSingle(),
    admin.from("billing_rate_config").select("*").eq("id", true).maybeSingle(),
  ]);

  // No cost profile at all defaults to "qualified" (the flat rate needs no
  // cost data), same default as the trade_level column itself.
  const tradeLevel: "qualified" | "apprentice" = costProfile?.trade_level === "apprentice" ? "apprentice" : "qualified";

  const rateConfig: LabourRateConfig = rateConfigRow
    ? {
        qualifiedBaseRate: Number(rateConfigRow.qualified_base_rate),
        apprenticeMarginPct: Number(rateConfigRow.apprentice_margin_pct),
        timeAndHalfMultiplier: Number(rateConfigRow.time_and_half_multiplier),
        doubleTimeMultiplier: Number(rateConfigRow.double_time_multiplier),
      }
    : DEFAULT_LABOUR_RATE_CONFIG;
  const callOutFee = rateConfigRow ? Number(rateConfigRow.call_out_fee) : 180;

  let loadedHourlyCost: number | undefined;
  if (tradeLevel === "apprentice" && costProfile) {
    const { data: assignedEquipment } = await admin
      .from("equipment")
      .select("purchase_cost, estimated_life_years, insurance_annual, maintenance_annual, registration_annual, other_annual_costs, fuel_cost_per_hour, target_hours_per_year")
      .eq("assigned_to", entry.staff_id);
    const vehicleCostPerHour = (assignedEquipment ?? []).reduce(
      (sum, eq) => sum + computeEquipmentCost(eq as EquipmentCostInputs).costPerHour,
      0
    );
    loadedHourlyCost = computeLoadedCost({
      hourly_rate: Number(costProfile.hourly_rate),
      super_rate: Number(costProfile.super_rate),
      workers_comp_rate: Number(costProfile.workers_comp_rate),
      leave_loading_rate: Number(costProfile.leave_loading_rate),
      annual_fixed_oncosts: Number(costProfile.annual_fixed_oncosts),
      target_hours_per_week: Number(costProfile.target_hours_per_week),
      vehicle_cost_per_hour: vehicleCostPerHour,
    }).loadedHourlyRate;
  }

  const breakdown = splitHoursByBand(entry.clock_in, entry.clock_out);
  const charge = computeLabourCharge({ tradeLevel, breakdown, rateConfig, loadedHourlyCost });
  const unitPrice = breakdown.totalHours > 0 ? charge.totalCharge / breakdown.totalHours : 0;

  const { data: existingItem } = await admin.from("job_items").select("id").eq("time_entry_id", timeEntryId).maybeSingle();

  const labourRow = {
    job_id: entry.job_id,
    time_entry_id: entry.id,
    staff_id: entry.staff_id,
    source: "auto_labour" as const,
    name: "Labour",
    description: describeBreakdown(breakdown, charge),
    quantity: Number(breakdown.totalHours.toFixed(2)),
    unit_price: Number(unitPrice.toFixed(2)),
  };

  if (existingItem) {
    await admin.from("job_items").update(labourRow).eq("id", existingItem.id);
  } else {
    await admin.from("job_items").insert(labourRow);
  }

  // First work entry logged on a job auto-adds the one-off call-out fee
  // (covers travel -- travel time_entries are never separately billed).
  const { data: existingCallout } = await admin
    .from("job_items")
    .select("id")
    .eq("job_id", entry.job_id)
    .eq("source", "auto_callout")
    .maybeSingle();

  if (!existingCallout) {
    await admin.from("job_items").insert({
      job_id: entry.job_id,
      source: "auto_callout",
      name: "Call Out Fee",
      description: "Covers travel to and from site",
      quantity: 1,
      unit_price: callOutFee,
    });
  }

  return NextResponse.json({ ok: true, breakdown, charge });
}
