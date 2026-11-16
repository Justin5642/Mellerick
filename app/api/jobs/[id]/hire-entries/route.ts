import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireOnJob } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { reportError } from "@/lib/monitoring";
import { buildDayWorksView, type EntryRow, type MachineRow, type OtherAttachmentUse } from "@/lib/day-works-view";

// The job's Day Works / Hire tab (Stage 1, Nov 2026): the machines that can be
// hired out, the attachments, this job's entries and any attachment clashes.
//
// `equipment`, `equipment_hire_options` and `hire_attachments` are office/admin
// only by RLS (they carry costs and rates), so they are read here through the
// service role, after requireOnJob, and lib/day-works-view.ts copies names and
// flags only — amounts are added for office/admin alone. The entries are read
// with the CALLER's session, so RLS (jobs you are on) still decides.
//
// Writes (add, edit, sign, delete a draft; office void) go straight from the
// browser under RLS and the hire_entries_guard trigger. Before the Day Works
// migration (drafted, not yet applied) is in the database this answers
// { ready: false } and the tab says so.

const MISSING_TABLE = new Set(["42P01", "PGRST205", "PGRST200"]);

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: jobId } = await params;
  const guard = await requireOnJob(request, jobId);
  if (!guard.ok) return guard.response;
  const isOffice = guard.role === "office" || guard.role === "admin";

  try {
    const admin = createAdminClient();
    const supabase = await callerClient(request);

    const [machinesRes, attachmentsRes, entriesRes, centresRes] = await Promise.all([
      admin
        .from("equipment")
        .select("id, name, is_active, equipment_hire_options(hire_type, hire_unit, rate, whole_days_only, fuel_included, float_base, float_km_included, float_per_km, cost_centre_id, is_active)")
        .order("name"),
      admin.from("hire_attachments").select("id, name, day_rate, is_active").order("name"),
      supabase
        .from("hire_entries")
        .select("*, hire_entry_attachments(attachment_id), profiles!hire_entries_created_by_fkey(full_name)")
        .eq("job_id", jobId)
        .order("work_date", { ascending: false })
        .order("created_at", { ascending: false }),
      admin.from("cost_centres").select("id, name"),
    ]);
    for (const r of [machinesRes, attachmentsRes, entriesRes]) {
      if (r.error && MISSING_TABLE.has(r.error.code ?? "")) return NextResponse.json({ ready: false });
    }
    if (machinesRes.error) throw machinesRes.error;
    if (attachmentsRes.error) throw attachmentsRes.error;
    if (entriesRes.error) throw entriesRes.error;
    if (centresRes.error) throw centresRes.error;

    type RawEntry = Omit<EntryRow, "attachment_ids" | "created_by_name"> & {
      hire_entry_attachments: { attachment_id: string }[] | null;
      profiles: { full_name: string | null } | null;
    };
    const entries: EntryRow[] = ((entriesRes.data ?? []) as unknown as RawEntry[]).map(({ hire_entry_attachments, profiles, ...e }) => ({
      ...e,
      attachment_ids: (hire_entry_attachments ?? []).map((a) => a.attachment_id),
      created_by_name: profiles?.full_name ?? null,
    }));

    type RawMachine = Omit<MachineRow, "options"> & { equipment_hire_options: MachineRow["options"] | null };
    const machines: MachineRow[] = ((machinesRes.data ?? []) as unknown as RawMachine[]).map(({ equipment_hire_options, ...m }) => ({
      ...m,
      options: (equipment_hire_options ?? []).map((o) => ({ ...o, equipment_id: m.id })),
    }));

    // Other entries (on any job) ticking the same attachments on the same days.
    const attachmentIds = [...new Set(entries.flatMap((e) => e.attachment_ids))];
    const dates = [...new Set(entries.filter((e) => e.attachment_ids.length > 0).map((e) => e.work_date))];
    let others: OtherAttachmentUse[] = [];
    if (attachmentIds.length > 0) {
      const { data, error } = await admin
        .from("hire_entry_attachments")
        .select("entry_id, attachment_id, hire_entries!inner(equipment_id, work_date, status, jobs(job_number))")
        .in("attachment_id", attachmentIds)
        .in("hire_entries.work_date", dates)
        .neq("hire_entries.status", "void");
      if (error) throw error;
      type RawOther = { entry_id: string; attachment_id: string; hire_entries: { equipment_id: string; work_date: string; status: string; jobs: { job_number: number } | null } };
      others = ((data ?? []) as unknown as RawOther[]).map((o) => ({
        entry_id: o.entry_id,
        attachment_id: o.attachment_id,
        equipment_id: o.hire_entries.equipment_id,
        work_date: o.hire_entries.work_date,
        status: o.hire_entries.status,
        job_number: o.hire_entries.jobs?.job_number ?? null,
      }));
    }

    // Signatures live in job-documents under this job; the caller is on the job.
    const paths = entries.map((e) => e.signature_path).filter((p): p is string => !!p);
    const signatureUrls = new Map<string, string>();
    if (paths.length > 0) {
      const { data: signed } = await admin.storage.from("job-documents").createSignedUrls(paths, 3600);
      for (const s of signed ?? []) if (s.path && s.signedUrl) signatureUrls.set(s.path, s.signedUrl);
    }

    const view = buildDayWorksView({
      isOffice,
      jobId,
      machines,
      attachments: attachmentsRes.data ?? [],
      entries,
      others,
      costCentreNames: new Map((centresRes.data ?? []).map((c) => [c.id as string, c.name as string])),
      signatureUrls,
    });
    return NextResponse.json({ ready: true, isOffice, userId: guard.userId, ...view });
  } catch (err) {
    console.error("day works list error:", err);
    reportError(err, { route: "api/jobs/hire-entries" });
    return NextResponse.json({ error: "Couldn't load Day Works. Try again." }, { status: 500 });
  }
}
