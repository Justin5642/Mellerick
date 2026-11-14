import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { reportError } from "@/lib/monitoring";

// Truck and plant usage logged from the phone (Stage 7, 31 Oct 2026): the
// driver logs a cartage run — hours and/or loads — against the job's
// Transport line. `equipment` is office/admin only by RLS (it carries costs),
// so the list of names comes through the service role here, field by field,
// with no cost columns. The usage row itself is written with the CALLER's
// session, so 0074's rule (only on jobs you can manage) still decides.

type Admin = ReturnType<typeof createAdminClient>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const melbourneToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Melbourne" });

async function jobLines(admin: Admin, jobId: string) {
  const { data, error } = await admin
    .from("po_cost_centers")
    .select("id, name, cost_centres(name), purchase_orders!inner(job_id)")
    .eq("purchase_orders.job_id", jobId);
  if (error) throw error;
  return ((data ?? []) as unknown as { id: string; name: string; cost_centres: { name: string } | null }[]).map((l) => ({
    id: l.id,
    name: l.name,
    costCentre: l.cost_centres?.name ?? null,
  }));
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireUser(request);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  try {
    const admin = createAdminClient();
    const [equipmentRes, lines, usageRes] = await Promise.all([
      // day_rate is read only to say WHETHER an item is day-rated (0100 — draft,
      // not applied yet); the amount never leaves the server.
      admin.from("equipment").select("id, name, category, day_rate").eq("is_active", true).order("name"),
      jobLines(admin, id),
      admin
        .from("equipment_usage_log")
        .select("id, equipment_id, usage_date, hours, loads, days, cost_center_id, logged_by, equipment(name), profiles(full_name)")
        .eq("job_id", id)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);
    if (equipmentRes.error) throw equipmentRes.error;
    if (usageRes.error) throw usageRes.error;
    type UsageRow = { id: string; equipment_id: string; usage_date: string; hours: number; loads: number | null; days: number | null; cost_center_id: string | null; logged_by: string | null; equipment: { name: string } | null; profiles: { full_name: string } | null };
    const rows = (usageRes.data ?? []) as unknown as UsageRow[];
    return NextResponse.json({
      equipment: (equipmentRes.data ?? []).map((e) => ({
        id: e.id as string,
        name: e.name as string,
        category: e.category as string,
        dayRated: Number((e as { day_rate?: number | null }).day_rate ?? 0) > 0,
      })),
      // Tools ticked on this job today — the phone shows them as ticked, and
      // lets the person who ticked one untick it.
      toolsToday: rows
        .filter((u) => Number(u.days ?? 0) > 0 && u.usage_date === melbourneToday())
        .map((u) => ({ id: u.id, equipmentId: u.equipment_id, loggedBy: u.profiles?.full_name ?? null, mine: u.logged_by === guard.userId })),
      lines,
      usage: rows.map((u) => ({
        id: u.id,
        date: u.usage_date,
        hours: Number(u.hours),
        loads: Number(u.loads ?? 0),
        days: Number(u.days ?? 0),
        costCenterId: u.cost_center_id,
        equipment: u.equipment?.name ?? "Equipment",
        loggedBy: u.profiles?.full_name ?? null,
      })),
    });
  } catch (err) {
    console.error("plant usage list error:", err);
    reportError(err, { route: "api/jobs/plant-usage" });
    return NextResponse.json({ error: "Couldn't load truck and plant. Try again." }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireUser(request);
  if (!guard.ok) return guard.response;
  const { id: jobId } = await params;
  const b = ((await request.json().catch(() => null)) ?? {}) as Record<string, unknown>;

  const equipmentId = b.equipmentId;
  if (typeof equipmentId !== "string" || !UUID.test(equipmentId)) return NextResponse.json({ error: "Pick the truck or machine." }, { status: 400 });
  const hours = Number(b.hours ?? 0);
  const loads = Number(b.loads ?? 0);
  // A "tool used today" tap (0100 — draft, not applied yet): one full day,
  // nothing else.
  const days = Number(b.days ?? 0);
  if (days !== 0 && days !== 1) return NextResponse.json({ error: "Tools are logged one day at a time." }, { status: 400 });
  if (days === 1 && (hours !== 0 || loads !== 0)) return NextResponse.json({ error: "Log the tool on its own, without hours or loads." }, { status: 400 });
  if (!Number.isFinite(hours) || hours < 0 || hours > 24) return NextResponse.json({ error: "Check the hours." }, { status: 400 });
  if (!Number.isInteger(loads) || loads < 0 || loads > 99) return NextResponse.json({ error: "Check the number of loads." }, { status: 400 });
  if (days === 0 && hours === 0 && loads === 0) return NextResponse.json({ error: "Enter the hours, the loads, or both." }, { status: 400 });
  const costCenterId = b.costCenterId == null || b.costCenterId === "" ? null : b.costCenterId;
  if (costCenterId !== null && (typeof costCenterId !== "string" || !UUID.test(costCenterId))) {
    return NextResponse.json({ error: "Pick the cost centre again." }, { status: 400 });
  }

  try {
    const admin = createAdminClient();
    if (costCenterId && !(await jobLines(admin, jobId)).some((l) => l.id === costCenterId)) {
      return NextResponse.json({ error: "That cost centre isn't on this job. Pick it again." }, { status: 400 });
    }
    if (days === 1) {
      const { data: eq, error: eqErr } = await admin.from("equipment").select("day_rate, is_active").eq("id", equipmentId).maybeSingle();
      if (eqErr) throw eqErr;
      if (!eq || !eq.is_active || !(Number(eq.day_rate) > 0)) {
        return NextResponse.json({ error: "That isn't on the tools list. Ask the office to set it up." }, { status: 400 });
      }
    }
    const supabase = await callerClient(request);
    const { error } = await supabase.from("equipment_usage_log").insert({
      equipment_id: equipmentId,
      job_id: jobId,
      usage_date: melbourneToday(),
      hours: Math.round(hours * 100) / 100,
      loads,
      days,
      cost_center_id: costCenterId,
      logged_by: guard.userId,
    });
    if (error) {
      // RLS (0074): only on a job you're on.
      if (error.code === "42501") return NextResponse.json({ error: "You can only log truck or plant on jobs you're on." }, { status: 403 });
      // 0100: one tool-day per job per item per date — someone already ticked it.
      if (error.code === "23505" && days === 1) return NextResponse.json({ ok: true, alreadyLogged: true });
      throw error;
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("plant usage save error:", err);
    reportError(err, { route: "api/jobs/plant-usage" });
    return NextResponse.json({ error: "Couldn't save it. Try again." }, { status: 500 });
  }
}

// Untick a tool logged on this job today (0100 — draft, not applied yet).
// Only a tool-day row from today: anything older is the office's to correct,
// and hours/loads entries are not touched from here. Runs as the caller, so
// RLS (0074: jobs you're on) decides as it does for the insert.
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireUser(request);
  if (!guard.ok) return guard.response;
  const { id: jobId } = await params;
  const usageId = request.nextUrl.searchParams.get("usageId");
  if (!usageId || !UUID.test(usageId)) return NextResponse.json({ error: "Pick the tool again." }, { status: 400 });
  try {
    const supabase = await callerClient(request);
    const { error, count } = await supabase
      .from("equipment_usage_log")
      .delete({ count: "exact" })
      .eq("id", usageId)
      .eq("job_id", jobId)
      .gt("days", 0)
      .eq("usage_date", melbourneToday());
    if (error) throw error;
    if (count === 0) return NextResponse.json({ error: "Only today's ticks can be removed here. Ask the office to fix older ones." }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("plant usage remove error:", err);
    reportError(err, { route: "api/jobs/plant-usage" });
    return NextResponse.json({ error: "Couldn't remove it. Try again." }, { status: 500 });
  }
}
