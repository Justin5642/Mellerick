import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { isMissingTable, parseNewAttachment } from "@/lib/fleet-office";

// Add a hire attachment (trencher, rock breaker…) with its day rate, from the
// phone (office/admin; the web's components/fleet/hire-attachments.tsx).
// hire_attachments is office/admin only by RLS; the insert runs as the caller.

export async function POST(request: NextRequest) {
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;

  const parsed = parseNewAttachment(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const db = await callerClient(request);
  const { data, error } = await db.from("hire_attachments").insert(parsed.value).select("id, name, day_rate, is_active, notes").single();
  if (error || !data) {
    if (error?.code === "23505") return NextResponse.json({ error: "There's already an attachment with that name." }, { status: 409 });
    if (isMissingTable(error)) return NextResponse.json({ error: "Day Works / Hire isn't switched on in this database yet." }, { status: 409 });
    console.error("hire attachment insert failed", error);
    return NextResponse.json({ error: "Couldn't add the attachment. Try again." }, { status: 500 });
  }
  return NextResponse.json({ attachment: data });
}
