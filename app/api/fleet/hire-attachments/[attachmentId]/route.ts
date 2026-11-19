import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { isUuid, parseAttachmentPatch } from "@/lib/fleet-office";

// Change a hire attachment's day rate or whether it's offered, from the phone
// (office/admin; the web card's own edits). Runs as the caller under RLS; an
// update that matched nothing is refused, never reported as saved.

type Ctx = { params: Promise<{ attachmentId: string }> };

const NOT_FOUND = "That attachment isn't there any more. Refresh to see the list.";

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const { attachmentId } = await params;
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  if (!isUuid(attachmentId)) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });

  const parsed = parseAttachmentPatch(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const db = await callerClient(request);
  const { data, error } = await db
    .from("hire_attachments")
    .update(parsed.value)
    .eq("id", attachmentId)
    .select("id, name, day_rate, is_active, notes")
    .maybeSingle();
  if (error) {
    console.error("hire attachment update failed", error);
    return NextResponse.json({ error: "Couldn't save the attachment. Try again." }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
  return NextResponse.json({ attachment: data });
}
