import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { isUuid } from "@/lib/fleet-office";
import { loadKomtraxForEquipment } from "@/lib/komtrax-data";

// One fleet item's Komtrax data for the phone's machine screen (office/admin,
// online — the 0113 (draft) tables are in no PowerSync stream): latest hours, position,
// fuel and the last 30 days' fault codes. Read as the CALLER (RLS). No money.

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  if (!isUuid(id)) return NextResponse.json({ error: "That machine isn't in the fleet register." }, { status: 404 });
  try {
    const db = await callerClient(request);
    return NextResponse.json(await loadKomtraxForEquipment(db, id));
  } catch (err) {
    console.error("fleet komtrax: read failed", err);
    return NextResponse.json({ error: "Couldn't load the Komtrax data. Try again." }, { status: 500 });
  }
}
