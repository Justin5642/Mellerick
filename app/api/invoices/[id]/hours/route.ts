import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { createAdminClient } from "@/lib/supabase/admin";
import { applyInvoiceHours, loadInvoiceHours } from "@/lib/invoice-hours";
import type { RateChoice, RateMode } from "@/lib/approved-hours";

// The job's hours for an invoice (GET) and "Apply hourly rate" (POST).
// See lib/invoice-hours.ts and migration 0098 (draft, not applied yet).

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;

  try {
    // Service role only for the rate defaults RLS hides from office staff;
    // the caller is authorised above.
    const view = await loadInvoiceHours(await callerClient(request), createAdminClient(), id);
    if (!view) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    return NextResponse.json(view);
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Could not load the job's hours" }, { status: 500 });
  }
}

const MODES: RateMode[] = ["all", "technician", "cost_centre"];
const rateMap = (v: unknown) =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, r]) => [k, r == null || r === "" ? null : Number(r)]))
    : undefined;

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;

  const body = await request.json().catch(() => null);
  if (!body || !MODES.includes(body.mode)) {
    return NextResponse.json({ error: "Choose how to apply the rate: one rate, per technician, or per cost centre." }, { status: 400 });
  }
  const choice: RateChoice = {
    mode: body.mode,
    all: body.all == null || body.all === "" ? null : Number(body.all),
    byStaff: rateMap(body.byStaff),
    byCostCentre: rateMap(body.byCostCentre),
  };

  const result = await applyInvoiceHours(await callerClient(request), id, choice);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json(result);
}
