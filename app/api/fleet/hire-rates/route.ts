import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { fleetHireOverview } from "@/lib/fleet-hire-overview";
import { isMissingTable } from "@/lib/fleet-office";

// Fleet → Hire rates for the phone (office/admin): every machine Day Works
// lists with its hire options and rates (lib/fleet-hire-overview.ts, the web
// card's own rule), unpriced first, plus the hire attachments and their day
// rates. Read as the caller — both tables are office/admin only by RLS.

export async function GET(request: NextRequest) {
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;

  const db = await callerClient(request);
  const [equipment, options, attachments] = await Promise.all([
    db.from("equipment").select("id, name, category, is_active").order("name"),
    db.from("equipment_hire_options").select("*"),
    db.from("hire_attachments").select("id, name, day_rate, is_active, notes").order("name"),
  ]);
  if (equipment.error) {
    console.error("fleet hire rates: equipment read failed", equipment.error);
    return NextResponse.json({ error: "Couldn't load the hire rates. Try again." }, { status: 500 });
  }
  if (options.error || attachments.error) {
    const e = options.error ?? attachments.error;
    if (isMissingTable(e)) return NextResponse.json({ ready: false, rows: [], missing: 0, attachments: [] });
    console.error("fleet hire rates: read failed", e);
    return NextResponse.json({ error: "Couldn't load the hire rates. Try again." }, { status: 500 });
  }
  const { rows, missing } = fleetHireOverview(equipment.data ?? [], options.data ?? []);
  return NextResponse.json({ ready: true, rows, missing, attachments: attachments.data ?? [] });
}
