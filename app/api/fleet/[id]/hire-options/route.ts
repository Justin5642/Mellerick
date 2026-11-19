import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { isMissingTable, isUuid, planHireOptionsSave } from "@/lib/fleet-office";

// Fleet → Hire setup for one machine, for the phone (office/admin; the web's
// components/fleet/equipment-hire-dialog.tsx). equipment_hire_options carries
// rates and is office/admin only by RLS; everything runs as the caller.
//
// GET  the machine, its hire options and the company cost centres.
// PUT  { options: [...] } — saved by (machine, type, unit); anything no longer
//      listed is removed (the web dialog's rule). Answers with the fresh list.

type Ctx = { params: Promise<{ id: string }> };

const NOT_FOUND = "That machine isn't in the fleet register.";
const NOT_ON = "Day Works / Hire isn't switched on in this database yet.";

async function load(db: Awaited<ReturnType<typeof callerClient>>, id: string) {
  const [machine, options, centres] = await Promise.all([
    db.from("equipment").select("id, name, category").eq("id", id).maybeSingle(),
    db.from("equipment_hire_options").select("*").eq("equipment_id", id).order("hire_type").order("hire_unit"),
    db.from("cost_centres").select("id, name").eq("is_active", true).order("sort_order").order("name"),
  ]);
  return { machine, options, centres };
}

export async function GET(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  if (!isUuid(id)) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });

  const db = await callerClient(request);
  const { machine, options, centres } = await load(db, id);
  if (machine.error) {
    console.error("fleet hire options: machine read failed", machine.error);
    return NextResponse.json({ error: "Couldn't load the hire setup. Try again." }, { status: 500 });
  }
  if (!machine.data) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  if (options.error) {
    if (isMissingTable(options.error)) return NextResponse.json({ ready: false, machine: machine.data, options: [], costCentres: [] });
    console.error("fleet hire options: read failed", options.error);
    return NextResponse.json({ error: "Couldn't load the hire setup. Try again." }, { status: 500 });
  }
  if (centres.error) console.error("fleet hire options: cost centres read failed", centres.error);
  return NextResponse.json({ ready: true, machine: machine.data, options: options.data ?? [], costCentres: centres.data ?? [] });
}

export async function PUT(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  if (!isUuid(id)) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });

  const body = await request.json().catch(() => null);
  const db = await callerClient(request);
  const { data: existing, error: readError } = await db.from("equipment_hire_options").select("id, hire_type, hire_unit").eq("equipment_id", id);
  if (readError) {
    if (isMissingTable(readError)) return NextResponse.json({ error: NOT_ON }, { status: 409 });
    console.error("fleet hire options: read before save failed", readError);
    return NextResponse.json({ error: "Couldn't save the hire setup. Try again." }, { status: 500 });
  }
  const plan = planHireOptionsSave(id, existing ?? [], body);
  if (!plan.ok) return NextResponse.json({ error: plan.error }, { status: 400 });

  const { data: machine, error: machineError } = await db.from("equipment").select("id").eq("id", id).maybeSingle();
  if (machineError || !machine) {
    if (machineError) console.error("fleet hire options: machine read failed", machineError);
    return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  }

  if (plan.value.deleteIds.length > 0) {
    const { error, count } = await db.from("equipment_hire_options").delete({ count: "exact" }).in("id", plan.value.deleteIds);
    if (error || count !== plan.value.deleteIds.length) {
      console.error("fleet hire options: delete failed", error);
      return NextResponse.json({ error: "Couldn't remove a way of hiring. Nothing else was changed." }, { status: 500 });
    }
  }
  if (plan.value.upserts.length > 0) {
    const { error } = await db.from("equipment_hire_options").upsert(plan.value.upserts, { onConflict: "equipment_id,hire_type,hire_unit" });
    if (error) {
      console.error("fleet hire options: save failed", error);
      // 0111 adds tonne / m³; before it the check constraint refuses them.
      const unitRefused = error.code === "23514";
      return NextResponse.json(
        { error: unitRefused ? "The database refused that way of charging. Per tonne / m³ needs truck loads switched on." : "Couldn't save the hire setup. Try again." },
        { status: unitRefused ? 400 : 500 },
      );
    }
  }
  const { options, centres } = await load(db, id);
  if (options.error) {
    console.error("fleet hire options: reload failed", options.error);
    return NextResponse.json({ error: "Saved, but the list couldn't be reloaded. Refresh to see it." }, { status: 500 });
  }
  return NextResponse.json({ ready: true, options: options.data ?? [], costCentres: centres.data ?? [] });
}
