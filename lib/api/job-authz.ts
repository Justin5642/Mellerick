import type { SupabaseClient } from "@supabase/supabase-js";

// True if the user holds a back-office role (admin or office). Reads via a
// service-role client since it looks up another user's profile row.
export async function isOfficeOrAdmin(admin: SupabaseClient, userId: string): Promise<boolean> {
  const { data } = await admin.from("profiles").select("role").eq("id", userId).single();
  return data?.role === "admin" || data?.role === "office";
}

// Per-record authorization for job billing actions. Office/admin may reconcile
// any job's billing; a technician may reconcile only a job they're assigned to
// (jobs.assigned_to) — this preserves the fire-and-forget mobile self-heal that
// runs after a tech logs their own time, without letting a tech touch another
// job's financial rows. Takes a service-role client since it reads role +
// assignment across users.
export async function canManageJobBilling(
  admin: SupabaseClient,
  userId: string,
  jobId: string
): Promise<boolean> {
  const [office, { data: job }] = await Promise.all([
    isOfficeOrAdmin(admin, userId),
    admin.from("jobs").select("assigned_to").eq("id", jobId).maybeSingle(),
  ]);

  if (office) return true;
  return !!job && job.assigned_to === userId;
}

// Same policy keyed on a time entry: resolve its job, then defer to the job
// rule. Returns false (not found) if the entry doesn't exist.
export async function canManageTimeEntryBilling(
  admin: SupabaseClient,
  userId: string,
  timeEntryId: string
): Promise<{ allowed: boolean; jobId: string | null }> {
  const { data: entry } = await admin
    .from("time_entries")
    .select("job_id")
    .eq("id", timeEntryId)
    .maybeSingle();

  if (!entry) return { allowed: false, jobId: null };
  const allowed = await canManageJobBilling(admin, userId, entry.job_id);
  return { allowed, jobId: entry.job_id };
}
