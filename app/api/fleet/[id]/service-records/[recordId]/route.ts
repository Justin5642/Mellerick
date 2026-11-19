import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { isUuid } from "@/lib/fleet-office";

// Delete one service record from the phone (office/admin), as the web's bin
// icon does. Its cost (if any) stays in the machine's expenses. Runs as the
// caller, so 0099's RLS decides; a delete that matched nothing is refused,
// never reported as done.

type Ctx = { params: Promise<{ id: string; recordId: string }> };

const NOT_FOUND = "That service record isn't there any more. Refresh to see the list.";

export async function DELETE(request: NextRequest, { params }: Ctx) {
  const { id, recordId } = await params;
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  if (!isUuid(id) || !isUuid(recordId)) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });

  const db = await callerClient(request);
  const { error, count } = await db
    .from("equipment_service_records")
    .delete({ count: "exact" })
    .eq("id", recordId)
    .eq("equipment_id", id);
  if (error) {
    console.error("fleet service record delete failed", error);
    return NextResponse.json({ error: "Couldn't delete the service record. Try again." }, { status: 500 });
  }
  if (count === 0) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
