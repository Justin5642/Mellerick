import type { NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { callerClient } from "@/lib/api/caller-client";
import { buildDayWorksView, type DayWorksView, type EntryRow, type MachineRow, type OtherAttachmentUse } from "@/lib/day-works-view";
import type { HireOptionFlags } from "@/lib/day-works-entry";
import type { HireType, HireUnit } from "@/lib/hire-pricing";
import { loadMeterReadings } from "@/lib/komtrax-data";
import type { MeterReadings } from "@/lib/komtrax-meter";

// Reads behind the job's Day Works / Hire tab, shared by every
// /api/jobs/[id]/hire-entries route: the GET, and each write, which answers
// with the fresh tab so the phone never needs a second round trip.
//
// `equipment`, `equipment_hire_options` and `hire_attachments` are office/admin
// only by RLS (they carry costs and rates), so they are read here through the
// service role — callers MUST have passed requireOnJob first — and
// lib/day-works-view.ts copies names and flags only; amounts are added for
// office/admin alone. The entries are read with the CALLER's session, so RLS
// (jobs you are on) still decides.

const MISSING_TABLE = new Set(["42P01", "PGRST205", "PGRST200"]);

// meter_readings: Komtrax hour-meter readings (0113) by machine and Melbourne
// day, for prefilling an engine-hour line's meter open/close. Hours only — the
// crew may see them. Empty when Komtrax isn't set up.
export type DayWorksLoad = { ready: false } | ({ ready: true; isOffice: boolean; userId: string; meter_readings: MeterReadings } & DayWorksView);

export async function loadDayWorks(request: NextRequest, jobId: string, caller: { userId: string; isOffice: boolean }): Promise<DayWorksLoad> {
  const { userId, isOffice } = caller;
  const admin = createAdminClient();
  const supabase = await callerClient(request);

  const [machinesRes, attachmentsRes, entriesRes, centresRes, meterReadings] = await Promise.all([
    admin
      .from("equipment")
      .select("id, name, is_active, category, equipment_hire_options(hire_type, hire_unit, rate, whole_days_only, fuel_included, float_base, float_km_included, float_per_km, cost_centre_id, is_active)")
      .order("name"),
    admin.from("hire_attachments").select("id, name, day_rate, is_active").order("name"),
    supabase
      .from("hire_entries")
      .select("*, hire_entry_attachments(attachment_id), profiles!hire_entries_created_by_fkey(full_name)")
      .eq("job_id", jobId)
      .order("work_date", { ascending: false })
      .order("created_at", { ascending: false }),
    admin.from("cost_centres").select("id, name"),
    loadMeterReadings(admin),
  ]);
  for (const r of [machinesRes, attachmentsRes, entriesRes]) {
    if (r.error && MISSING_TABLE.has(r.error.code ?? "")) return { ready: false };
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
  // Only machines the tab lists.
  const listed = new Set(view.machines.map((m) => m.id));
  const meter_readings: MeterReadings = Object.fromEntries(Object.entries(meterReadings).filter(([id]) => listed.has(id)));
  return { ready: true, isOffice, userId, meter_readings, ...view };
}

/**
 * The machine's active hire option for an entry, flags only (read with the
 * service role; the rate is never selected). Null = not set up for that hire.
 */
export async function hireOptionFlags(equipmentId: string, hireType: HireType, hireUnit: HireUnit): Promise<HireOptionFlags | null> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("equipment_hire_options")
    .select("hire_type, hire_unit, whole_days_only")
    .eq("equipment_id", equipmentId)
    .eq("hire_type", hireType)
    .eq("hire_unit", hireUnit)
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw error;
  return (data as HireOptionFlags | null) ?? null;
}
