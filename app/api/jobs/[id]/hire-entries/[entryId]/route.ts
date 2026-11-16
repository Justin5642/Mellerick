import { NextRequest, NextResponse } from "next/server";
import { requireOnJob } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { reportError } from "@/lib/monitoring";
import { loadDayWorks, hireOptionFlags } from "@/lib/day-works-load";
import { buildHireEntryRow, clashWarning, dayWorksWriteError, isUuid, parseHireEntryBody, rowLimitProblem } from "@/lib/day-works-entry";

// Edit (PATCH) or delete (DELETE) one Day Works draft from the phone (Stage 2).
// Same rules as the web tab: the CALLER's client, so RLS (crew of this job,
// drafts only) and 0108's hire_entries_guard decide; a signed entry is locked.
// Both answer with the fresh tab (lib/day-works-load.ts — no money for the crew).

type Ctx = { params: Promise<{ id: string; entryId: string }> };

const LOCKED = "This Day Works entry is signed and locked. Ask the office if it needs changing.";
const NOT_FOUND = "That Day Works entry isn't on this job any more. Refresh to see it.";

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const { id: jobId, entryId } = await params;
  const guard = await requireOnJob(request, jobId);
  if (!guard.ok) return guard.response;
  const isOffice = guard.role === "office" || guard.role === "admin";
  if (!isUuid(entryId)) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });

  const parsed = parseHireEntryBody(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const { input, attachmentIds } = parsed;
    const supabase = await callerClient(request);
    const { data: entry, error: readError } = await supabase
      .from("hire_entries")
      .select("id, job_id, status, hire_entry_attachments(attachment_id)")
      .eq("id", entryId)
      .eq("job_id", jobId)
      .maybeSingle();
    if (readError) throw readError;
    if (!entry) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });
    if (entry.status !== "draft") return NextResponse.json({ error: LOCKED }, { status: 409 });

    const opt = await hireOptionFlags(input.equipment_id, input.hire_type, input.hire_unit);
    const built = buildHireEntryRow(input, opt);
    if (!built.ok) return NextResponse.json({ error: built.error }, { status: 400 });
    const limit = rowLimitProblem(built.row);
    if (limit) return NextResponse.json({ error: limit }, { status: 400 });

    const { error, count } = await supabase
      .from("hire_entries")
      .update(built.row, { count: "exact" })
      .eq("id", entryId)
      .eq("job_id", jobId)
      .eq("status", "draft");
    if (error) {
      const refused = dayWorksWriteError(error);
      if (refused.status === 500) throw error;
      return NextResponse.json({ error: refused.error }, { status: refused.status });
    }
    if (count === 0) return NextResponse.json({ error: "This entry is signed or no longer yours to change. Refresh to see it." }, { status: 409 });

    let warning: string | null = null;
    const before = ((entry.hire_entry_attachments ?? []) as { attachment_id: string }[]).map((a) => a.attachment_id);
    const removed = before.filter((a) => !attachmentIds.includes(a));
    const added = attachmentIds.filter((a) => !before.includes(a));
    if (removed.length > 0) {
      const { error: delErr } = await supabase.from("hire_entry_attachments").delete().eq("entry_id", entryId).in("attachment_id", removed);
      if (delErr) {
        console.error("day works attachments not removed:", delErr);
        warning = "The entry was saved but its attachments were not. Edit it and tick them again.";
      }
    }
    if (added.length > 0) {
      const { error: addErr } = await supabase.from("hire_entry_attachments").insert(added.map((attachment_id) => ({ entry_id: entryId, attachment_id })));
      if (addErr) {
        console.error("day works attachments not added:", addErr);
        warning = "The entry was saved but its attachments were not. Edit it and tick them again.";
      }
    }

    const view = await loadDayWorks(request, jobId, { userId: guard.userId, isOffice });
    if (view.ready) warning = warning ?? clashWarning(view.clashes, entryId);
    return NextResponse.json({ ...view, saved: { id: entryId }, ...(warning ? { warning } : {}) });
  } catch (err) {
    console.error("day works edit error:", err);
    reportError(err, { route: "api/jobs/hire-entries/entry" });
    return NextResponse.json({ error: "Couldn't save the entry. Try again." }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: Ctx) {
  const { id: jobId, entryId } = await params;
  const guard = await requireOnJob(request, jobId);
  if (!guard.ok) return guard.response;
  const isOffice = guard.role === "office" || guard.role === "admin";
  if (!isUuid(entryId)) return NextResponse.json({ error: NOT_FOUND }, { status: 404 });

  try {
    const supabase = await callerClient(request);
    const { error, count } = await supabase
      .from("hire_entries")
      .delete({ count: "exact" })
      .eq("id", entryId)
      .eq("job_id", jobId)
      .eq("status", "draft");
    if (error) throw error;
    if (count === 0) {
      return NextResponse.json({ error: "Couldn't delete it — only unsigned entries can be deleted." }, { status: 409 });
    }
    return NextResponse.json(await loadDayWorks(request, jobId, { userId: guard.userId, isOffice }));
  } catch (err) {
    console.error("day works delete error:", err);
    reportError(err, { route: "api/jobs/hire-entries/entry" });
    return NextResponse.json({ error: "Couldn't delete the entry. Try again." }, { status: 500 });
  }
}
