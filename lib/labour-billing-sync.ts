// Server-side reconcile of a job's auto-generated billing items (the
// "Labour" line per billable work entry + a single one-off "Call Out Fee").
// This is the durable backbone behind the fire-and-forget per-entry sync
// (app/api/time-entries/[id]/sync-billing) and the job-level sync
// (app/api/jobs/[id]/sync-billing): rather than mutating one entry's line in
// isolation, it recomputes the whole job from its current time entries so a
// single dropped request can't leave the job permanently missing a charge.
// Idempotent -- safe to run repeatedly; it upserts what should exist and
// deletes auto rows that no longer should (e.g. an entry changed to travel,
// or was deleted).
//
// Uses a service-role client (job_items is Admin-only writable, see migration
// 0024); the calling route authenticates the user first, then hands us the
// elevated client.

import type { SupabaseClient } from "@supabase/supabase-js";
import { computeLoadedCost } from "@/lib/staff-cost";
import { computeEquipmentCost, type EquipmentCostInputs } from "@/lib/equipment-cost";
import {
  splitHoursByBand,
  computeLabourCharge,
  applyRateOverride,
  DEFAULT_LABOUR_RATE_CONFIG,
  type LabourRateConfig,
  type RateBand,
} from "@/lib/labour-billing";

interface WorkEntry {
  id: string;
  staff_id: string;
  clock_in: string;
  clock_out: string | null;
  entry_type: string | null;
  rate_override: RateBand | null;
}

function describeBreakdown(
  breakdown: ReturnType<typeof splitHoursByBand>,
  charge: ReturnType<typeof computeLabourCharge>,
  overridden: boolean
) {
  const parts: string[] = [];
  if (breakdown.normalHours > 0) parts.push(`${breakdown.normalHours.toFixed(2)}h @ $${charge.ordinaryHourlyRate.toFixed(2)}/hr`);
  if (breakdown.timeAndHalfHours > 0) parts.push(`${breakdown.timeAndHalfHours.toFixed(2)}h @ $${charge.timeAndHalfHourlyRate.toFixed(2)}/hr (1.5x)`);
  if (breakdown.doubleTimeHours > 0) parts.push(`${breakdown.doubleTimeHours.toFixed(2)}h @ $${charge.doubleTimeHourlyRate.toFixed(2)}/hr (2x)`);
  const description = parts.join(" + ") || "0h";
  return overridden ? `${description} (rate manually overridden)` : description;
}

/**
 * Refuse to price a job from a read that did not actually succeed.
 *
 * Named per table because three reads share one call site, and "permission
 * denied" alone does not say which one — the difference between "we could not
 * read the rates" and "we could not read the time entries" is the difference
 * between a wrong price and a deleted invoice line.
 */
function requireRead(result: { error: { message?: string } | null }, table: string): void {
  if (result.error) {
    throw new Error(`syncJobBilling: ${table} read failed — ${result.error.message ?? "unknown error"}`);
  }
}

// Recompute every auto billing item on a job from its current time entries.
// Returns a small summary for the caller/UI.
export async function syncJobBilling(admin: SupabaseClient, jobId: string) {
  const [entriesRes, rateConfigRes, existingItemsRes] = await Promise.all([
    admin
      .from("time_entries")
      .select("id, staff_id, clock_in, clock_out, entry_type, rate_override")
      .eq("job_id", jobId),
    admin.from("billing_rate_config").select("*").eq("id", true).maybeSingle(),
    admin.from("job_items").select("id, source, time_entry_id").eq("job_id", jobId).in("source", ["auto_labour", "auto_callout"]),
  ]);

  // A DISCARDED ERROR HERE CHANGES WHAT A CUSTOMER IS CHARGED.
  //
  // Each of these three reads used to drop its error, and two of them silently
  // produce a wrong invoice rather than no invoice:
  //
  //   billing_rate_config fails -> rateConfigRow is null -> indistinguishable
  //     from "no rate row configured", so the job re-prices at
  //     DEFAULT_LABOUR_RATE_CONFIG and a hardcoded $180 call-out.
  //   time_entries fails        -> entries is null -> billable is [] -> the
  //     reconcile below takes its DELETE path and erases the job's entire auto
  //     labour billing for work that was genuinely done.
  //   job_items fails           -> existingAutoItems is [] -> every line looks
  //     new, so the reconcile inserts duplicates instead of updating.
  //
  // Refusing to reconcile is recoverable — the caller gets a 500 and can retry.
  // A quietly mispriced invoice is not: it goes to the customer.
  requireRead(entriesRes, "time_entries");
  requireRead(rateConfigRes, "billing_rate_config");
  requireRead(existingItemsRes, "job_items");

  const entries = entriesRes.data;
  const rateConfigRow = rateConfigRes.data;
  const existingAutoItems = existingItemsRes.data;

  const rateConfig: LabourRateConfig = rateConfigRow
    ? {
        qualifiedBaseRate: Number(rateConfigRow.qualified_base_rate),
        apprenticeMarginPct: Number(rateConfigRow.apprentice_margin_pct),
        timeAndHalfMultiplier: Number(rateConfigRow.time_and_half_multiplier),
        doubleTimeMultiplier: Number(rateConfigRow.double_time_multiplier),
      }
    : DEFAULT_LABOUR_RATE_CONFIG;
  const callOutFee = rateConfigRow ? Number(rateConfigRow.call_out_fee) : 180;

  // Only closed work entries are billable -- travel is covered by the flat
  // call-out fee, and an open entry (no clock_out) has nothing to price yet.
  const billable = (entries ?? []).filter(
    (e): e is WorkEntry => e.entry_type === "work" && !!e.clock_out
  );

  // Cost profiles are only needed to price apprentices (their loaded cost +
  // margin); qualified staff bill at a flat/charge-out rate that needs no
  // cost data. Fetch the profiles for whoever logged billable time.
  const staffIds = [...new Set(billable.map((e) => e.staff_id))];
  const profileByStaff = new Map<string, any>();
  const vehicleCostByStaff = new Map<string, number>();
  if (staffIds.length > 0) {
    const [{ data: profiles }, { data: vehicles }] = await Promise.all([
      admin
        .from("staff_cost_profiles")
        .select("staff_id, hourly_rate, super_rate, workers_comp_rate, leave_loading_rate, annual_fixed_oncosts, target_hours_per_week, trade_level, charge_out_rate")
        .in("staff_id", staffIds),
      admin
        .from("equipment")
        .select("assigned_to, purchase_cost, estimated_life_years, insurance_annual, maintenance_annual, registration_annual, other_annual_costs, fuel_cost_per_hour, target_hours_per_year")
        .in("assigned_to", staffIds),
    ]);
    (profiles ?? []).forEach((p) => profileByStaff.set(p.staff_id, p));
    (vehicles ?? []).forEach((v: any) => {
      if (!v.assigned_to) return;
      vehicleCostByStaff.set(
        v.assigned_to,
        (vehicleCostByStaff.get(v.assigned_to) ?? 0) + computeEquipmentCost(v as EquipmentCostInputs).costPerHour
      );
    });
  }

  // Upsert one auto_labour row per billable entry, keyed by time_entry_id.
  const keptTimeEntryIds = new Set<string>();
  for (const entry of billable) {
    const profile = profileByStaff.get(entry.staff_id);
    const tradeLevel: "qualified" | "apprentice" = profile?.trade_level === "apprentice" ? "apprentice" : "qualified";

    let loadedHourlyCost: number | undefined;
    if (tradeLevel === "apprentice" && profile) {
      loadedHourlyCost = computeLoadedCost({
        hourly_rate: Number(profile.hourly_rate),
        super_rate: Number(profile.super_rate),
        workers_comp_rate: Number(profile.workers_comp_rate),
        leave_loading_rate: Number(profile.leave_loading_rate),
        annual_fixed_oncosts: Number(profile.annual_fixed_oncosts),
        target_hours_per_week: Number(profile.target_hours_per_week),
        vehicle_cost_per_hour: vehicleCostByStaff.get(entry.staff_id) ?? 0,
      }).loadedHourlyRate;
    }

    const breakdown = applyRateOverride(splitHoursByBand(entry.clock_in, entry.clock_out!), entry.rate_override);
    const staffChargeOutRate = profile?.charge_out_rate != null ? Number(profile.charge_out_rate) : null;
    const charge = computeLabourCharge({ tradeLevel, breakdown, rateConfig, loadedHourlyCost, staffChargeOutRate });
    const unitPrice = breakdown.totalHours > 0 ? charge.totalCharge / breakdown.totalHours : 0;

    const labourRow = {
      job_id: jobId,
      time_entry_id: entry.id,
      staff_id: entry.staff_id,
      source: "auto_labour" as const,
      name: "Labour",
      description: describeBreakdown(breakdown, charge, !!entry.rate_override),
      quantity: Number(breakdown.totalHours.toFixed(2)),
      unit_price: Number(unitPrice.toFixed(2)),
    };

    const existing = (existingAutoItems ?? []).find((i) => i.source === "auto_labour" && i.time_entry_id === entry.id);
    if (existing) {
      await admin.from("job_items").update(labourRow).eq("id", existing.id);
    } else {
      await admin.from("job_items").insert(labourRow);
    }
    keptTimeEntryIds.add(entry.id);
  }

  // Remove stale auto_labour rows whose entry is no longer billable (deleted,
  // switched to travel, or re-opened).
  const staleLabour = (existingAutoItems ?? []).filter(
    (i) => i.source === "auto_labour" && (!i.time_entry_id || !keptTimeEntryIds.has(i.time_entry_id))
  );
  if (staleLabour.length > 0) {
    await admin.from("job_items").delete().in("id", staleLabour.map((i) => i.id));
  }

  // Exactly one call-out fee while there's any billable work; none otherwise.
  const existingCallouts = (existingAutoItems ?? []).filter((i) => i.source === "auto_callout");
  if (billable.length > 0) {
    if (existingCallouts.length === 0) {
      await admin.from("job_items").insert({
        job_id: jobId,
        source: "auto_callout",
        name: "Call Out Fee",
        description: "Covers travel to and from site",
        quantity: 1,
        unit_price: callOutFee,
      });
    } else if (existingCallouts.length > 1) {
      // Collapse any accidental duplicates down to one.
      await admin.from("job_items").delete().in("id", existingCallouts.slice(1).map((i) => i.id));
    }
  } else if (existingCallouts.length > 0) {
    await admin.from("job_items").delete().in("id", existingCallouts.map((i) => i.id));
  }

  return { billableEntries: billable.length, labourItems: keptTimeEntryIds.size };
}
