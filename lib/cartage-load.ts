import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { callerClient } from "@/lib/api/caller-client";
import { buildTruckLoadsView, siteLabelOf, type LoadRow, type TruckLoadsView, type TruckRow } from "@/lib/cartage-view";
import type { LoadCost } from "@/lib/cartage-pricing";

// Reads behind the "Truck loads" section of the job's Day Works tab (0111, drafted — not applied yet),
// shared by every /api/jobs/[id]/cartage-loads route: the GET, and each
// write, which answers with the fresh section so the phone never needs a
// second round trip.
//
// `equipment`, `equipment_hire_options`, `suppliers`, `cartage_load_costs` and
// `billing_rate_config` are office/admin only by RLS, so they are read here
// through the service role — callers MUST have passed requireOnJob first —
// and lib/cartage-view.ts copies names only; costs, rates and prices are read
// and added for office/admin alone. The loads are read with the CALLER's
// session, so RLS (jobs you are on) still decides.

const MISSING = new Set(["42P01", "PGRST205", "PGRST200", "42703", "PGRST204"]);

export type TruckLoadsLoad = { ready: false } | ({ ready: true; isOffice: boolean; userId: string } & TruckLoadsView);

export async function loadTruckLoads(request: NextRequest, jobId: string, caller: { userId: string; isOffice: boolean }): Promise<TruckLoadsLoad> {
  const { userId, isOffice } = caller;
  const admin = createAdminClient();
  const supabase = await callerClient(request);

  const [trucksRes, suppliersRes, loadsRes, jobRes, centresRes] = await Promise.all([
    admin.from("equipment").select("id, name, is_active, category, equipment_hire_options(hire_type, hire_unit, rate, is_active)").order("name"),
    admin.from("suppliers").select("id, name, pin_order").eq("is_active", true).order("name"),
    supabase
      .from("cartage_loads")
      .select("*, profiles!cartage_loads_created_by_fkey(full_name)")
      .eq("job_id", jobId)
      .order("load_date", { ascending: false })
      .order("created_at", { ascending: false }),
    supabase.from("jobs").select("id, quarry_included, sites(name, address_line1, suburb)").eq("id", jobId).maybeSingle(),
    admin.from("cost_centres").select("id, name"),
  ]);
  for (const r of [loadsRes, jobRes]) {
    if (r.error && MISSING.has(r.error.code ?? "")) return { ready: false };
  }
  if (trucksRes.error) throw trucksRes.error;
  if (suppliersRes.error) throw suppliersRes.error;
  if (loadsRes.error) throw loadsRes.error;
  if (jobRes.error) throw jobRes.error;
  if (centresRes.error) throw centresRes.error;

  type RawLoad = Omit<LoadRow, "created_by_name"> & { profiles: { full_name: string | null } | null };
  const loads: LoadRow[] = ((loadsRes.data ?? []) as unknown as RawLoad[]).map(({ profiles, ...l }) => ({ ...l, created_by_name: profiles?.full_name ?? null }));

  type RawTruck = Omit<TruckRow, "options"> & { equipment_hire_options: TruckRow["options"] | null };
  const trucks: TruckRow[] = ((trucksRes.data ?? []) as unknown as RawTruck[]).map(({ equipment_hire_options, ...t }) => ({
    ...t,
    options: equipment_hire_options ?? [],
  }));

  type RawJob = { quarry_included: boolean | null; sites: { name: string | null; address_line1: string | null; suburb: string | null } | null };
  const job = jobRes.data as unknown as RawJob | null;

  // Signatures live in job-documents under this job's day-works folder; the caller is on the job.
  const sigPaths = [...new Set(loads.map((l) => l.signature_path).filter((p): p is string => !!p))];
  const signatureUrls = new Map<string, string>();
  if (sigPaths.length > 0) {
    const { data: signed } = await admin.storage.from("job-documents").createSignedUrls(sigPaths, 3600);
    for (const s of signed ?? []) if (s.path && s.signedUrl) signatureUrls.set(s.path, s.signedUrl);
  }

  let costs: Map<string, LoadCost> | undefined;
  let companyMarginPct: number | null = null;
  let docketUrls: Map<string, string> | undefined;
  if (isOffice) {
    const ids = loads.map((l) => l.id);
    const [costsRes, configRes] = await Promise.all([
      ids.length > 0
        ? admin.from("cartage_load_costs").select("load_id, docket_cost_ex_gst, margin_pct").in("load_id", ids)
        : Promise.resolve({ data: [], error: null }),
      admin.from("billing_rate_config").select("cartage_margin_pct").maybeSingle(),
    ]);
    if (costsRes.error) throw costsRes.error;
    if (configRes.error) throw configRes.error;
    costs = new Map(((costsRes.data ?? []) as (LoadCost & { load_id: string })[]).map((c) => [c.load_id, c]));
    companyMarginPct = (configRes.data as { cartage_margin_pct: number | null } | null)?.cartage_margin_pct ?? null;
    // Docket photos show prices: signed URLs for the office only.
    const docketPaths = [...new Set(loads.map((l) => l.docket_photo_path).filter((p): p is string => !!p))];
    docketUrls = new Map();
    if (docketPaths.length > 0) {
      const { data: signed } = await admin.storage.from("job-documents").createSignedUrls(docketPaths, 3600);
      for (const s of signed ?? []) if (s.path && s.signedUrl) docketUrls.set(s.path, s.signedUrl);
    }
  }

  const view = buildTruckLoadsView({
    isOffice,
    trucks,
    suppliers: (suppliersRes.data ?? []) as { id: string; name: string; pin_order: number | null }[],
    loads,
    quarryIncluded: job?.quarry_included ?? null,
    siteLabel: siteLabelOf(job?.sites ?? null),
    costCentreNames: new Map((centresRes.data ?? []).map((c) => [c.id as string, c.name as string])),
    signatureUrls,
    costs,
    companyMarginPct,
    docketUrls,
  });
  return { ready: true, isOffice, userId, ...view };
}
