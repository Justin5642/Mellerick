import { NextRequest, NextResponse } from "next/server";
import { requireOnJob } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { reportError } from "@/lib/monitoring";
import { loadDayWorks, hireOptionFlags } from "@/lib/day-works-load";
import { buildHireEntryRow, clashWarning, dayWorksWriteError, parseHireEntryBody, rowLimitProblem } from "@/lib/day-works-entry";

// The job's Day Works / Hire tab (Stage 1, Nov 2026): the machines that can be
// hired out, the attachments, this job's entries and any attachment clashes.
// The reads (and the money rule) are in lib/day-works-load.ts: names and
// quantities for the crew, amounts only for office/admin.
//
// Web writes (add, edit, sign, delete a draft; office void) go straight from
// the browser under RLS and the hire_entries_guard trigger. The phone (Stage 2)
// writes through these routes instead — POST here adds a draft;
// [entryId] edits or deletes one; [entryId]/sign signs it off — always with the
// CALLER's client, so RLS and the 0108 trigger apply exactly as on the web.
// Never the service role for a write. Every write answers with the fresh tab.

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: jobId } = await params;
  const guard = await requireOnJob(request, jobId);
  if (!guard.ok) return guard.response;
  const isOffice = guard.role === "office" || guard.role === "admin";

  try {
    return NextResponse.json(await loadDayWorks(request, jobId, { userId: guard.userId, isOffice }));
  } catch (err) {
    console.error("day works list error:", err);
    reportError(err, { route: "api/jobs/hire-entries" });
    return NextResponse.json({ error: "Couldn't load Day Works. Try again." }, { status: 500 });
  }
}

/**
 * Add a draft entry (the phone). Safe to retry with the same `id`: an entry
 * already saved under it on this job is answered as saved, not added twice.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: jobId } = await params;
  const guard = await requireOnJob(request, jobId);
  if (!guard.ok) return guard.response;
  const isOffice = guard.role === "office" || guard.role === "admin";

  const parsed = parseHireEntryBody(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const { input, attachmentIds } = parsed;
    const opt = await hireOptionFlags(input.equipment_id, input.hire_type, input.hire_unit);
    const built = buildHireEntryRow(input, opt);
    if (!built.ok) return NextResponse.json({ error: built.error }, { status: 400 });
    const limit = rowLimitProblem(built.row);
    if (limit) return NextResponse.json({ error: limit }, { status: 400 });

    const supabase = await callerClient(request);
    const entryId = parsed.id ?? crypto.randomUUID();
    let warning: string | null = null;

    const { data: existing, error: existingError } = await supabase.from("hire_entries").select("id, job_id").eq("id", entryId).maybeSingle();
    if (existingError) throw existingError;
    if (existing && existing.job_id !== jobId) {
      return NextResponse.json({ error: "That entry belongs to another job." }, { status: 409 });
    }
    if (!existing) {
      const { error } = await supabase.from("hire_entries").insert({ id: entryId, job_id: jobId, ...built.row });
      if (error) {
        const refused = dayWorksWriteError(error);
        if (refused.status === 500) throw error;
        return NextResponse.json({ error: refused.error }, { status: refused.status });
      }
      if (attachmentIds.length > 0) {
        const { error: addErr } = await supabase
          .from("hire_entry_attachments")
          .insert(attachmentIds.map((attachment_id) => ({ entry_id: entryId, attachment_id })));
        if (addErr) {
          console.error("day works attachments not saved:", addErr);
          warning = "The entry was saved but its attachments were not. Edit it and tick them again.";
        }
      }
    }

    const view = await loadDayWorks(request, jobId, { userId: guard.userId, isOffice });
    if (view.ready) warning = warning ?? clashWarning(view.clashes, entryId);
    return NextResponse.json({ ...view, saved: { id: entryId }, ...(warning ? { warning } : {}) }, { status: existing ? 200 : 201 });
  } catch (err) {
    console.error("day works add error:", err);
    reportError(err, { route: "api/jobs/hire-entries" });
    return NextResponse.json({ error: "Couldn't save the entry. Try again." }, { status: 500 });
  }
}
