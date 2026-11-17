import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/monitoring";
import { DEFAULT_CARTAGE_MARGIN_PCT } from "@/lib/cartage-pricing";

// The company margin on quarry product and tip fees charged on as Truck loads
// (billing_rate_config.cartage_margin_pct, 0111 (drafted — not applied yet)). Office/admin set it in
// Settings. billing_rate_config is admin-only by RLS (0024 — it also holds the
// labour charge-out rates), so this one column is read and written with the
// service role after requireOfficeOrAdmin; nothing else in that row is touched.

const MISSING = new Set(["42703", "PGRST204", "42P01", "PGRST205"]);

export async function GET(request: NextRequest) {
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  const { data, error } = await createAdminClient().from("billing_rate_config").select("cartage_margin_pct").maybeSingle();
  if (error) {
    if (MISSING.has(error.code ?? "")) return NextResponse.json({ ready: false });
    console.error("cartage margin read error:", error);
    return NextResponse.json({ error: "Couldn't read the margin. Try again." }, { status: 500 });
  }
  return NextResponse.json({ ready: true, marginPct: (data as { cartage_margin_pct: number | null } | null)?.cartage_margin_pct ?? DEFAULT_CARTAGE_MARGIN_PCT });
}

export async function POST(request: NextRequest) {
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  const body = (await request.json().catch(() => null)) as { marginPct?: unknown } | null;
  const v = typeof body?.marginPct === "number" ? body.marginPct : typeof body?.marginPct === "string" ? Number(body.marginPct) : NaN;
  if (!Number.isFinite(v) || v < 0 || v > 1000) return NextResponse.json({ error: "Enter a margin between 0 and 1000%." }, { status: 400 });
  const marginPct = Math.round(v * 100) / 100;

  const { data, error } = await createAdminClient()
    .from("billing_rate_config")
    .update({ cartage_margin_pct: marginPct, updated_at: new Date().toISOString(), updated_by: guard.userId })
    .eq("id", true)
    .select("cartage_margin_pct");
  if (error || (data ?? []).length === 0) {
    if (error && MISSING.has(error.code ?? "")) {
      return NextResponse.json({ error: "Truck loads aren't switched on yet — the database update for them still has to be applied." }, { status: 409 });
    }
    console.error("cartage margin save error:", error);
    reportError(error ?? new Error("billing_rate_config row missing"), { route: "api/settings/cartage-margin" });
    return NextResponse.json({ error: "Couldn't save the margin. Try again." }, { status: 500 });
  }
  return NextResponse.json({ ready: true, marginPct });
}
