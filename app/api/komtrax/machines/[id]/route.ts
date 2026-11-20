import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { isUuid } from "@/lib/fleet-office";
import { isKomtraxTableMissing } from "@/lib/komtrax";

// Link (or unlink) a Komtrax machine to a fleet item — Fleet → Komtrax
// machines. Office/admin; runs as the CALLER, so 0113's RLS and column grant
// (equipment_id, matched_by only) decide. matched_by = 'office' so the sync's
// serial match never overrides the office's choice — including an unlink.

type Ctx = { params: Promise<{ id: string }> };

const NOT_FOUND = "That Komtrax machine wasn't found.";
const SAVE_FAILED = "Couldn't save the link. Try again.";

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  if (!isUuid(id)) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });

  const body = (await request.json().catch(() => null)) as { equipment_id?: unknown } | null;
  const equipmentId = body?.equipment_id ?? null;
  if (equipmentId !== null && !isUuid(equipmentId)) return NextResponse.json({ error: "Pick a machine from the fleet register." }, { status: 400 });

  const db = await callerClient(request);
  if (equipmentId) {
    const { data: eq, error: eqErr } = await db.from("equipment").select("id").eq("id", equipmentId).maybeSingle();
    if (eqErr || !eq) return NextResponse.json({ error: "Pick a machine from the fleet register." }, { status: 400 });
  }
  const { data, error } = await db
    .from("komtrax_machines")
    .update({ equipment_id: equipmentId, matched_by: "office" })
    .eq("id", id)
    .select("id, equipment_id, matched_by")
    .maybeSingle();
  if (error) {
    if (isKomtraxTableMissing(error)) return NextResponse.json({ error: "Komtrax isn't switched on in this database yet." }, { status: 409 });
    if (error.code === "23505") return NextResponse.json({ error: "That fleet item is already linked to another Komtrax machine." }, { status: 409 });
    console.error("komtrax link failed", error);
    return NextResponse.json({ error: SAVE_FAILED }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  return NextResponse.json({ machine: data });
}
