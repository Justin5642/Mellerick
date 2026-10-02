import type { SupabaseClient } from "@supabase/supabase-js";

// True if the user holds a back-office role (admin or office). Reads via a
// service-role client since it looks up another user's profile row.
export async function isOfficeOrAdmin(admin: SupabaseClient, userId: string): Promise<boolean> {
  const { data } = await admin.from("profiles").select("role").eq("id", userId).single();
  return data?.role === "admin" || data?.role === "office";
}

// Per-record authorization for job billing actions. Office/admin may reconcile
// any job's billing; a technician may reconcile only a job they're assigned to
// (job_assignments — any current assignee, not just jobs.assigned_to's
// trigger-derived "primary") — this preserves the fire-and-forget mobile
// self-heal that runs after a tech logs their own time, without letting a tech
// touch another job's financial rows. Takes a service-role client since it
// reads role + assignment across users. Database-side counterpart:
// user_can_manage_job() (supabase/migrations/0059_add_job_assignments.sql) —
// if you change this rule, change that one too.
export async function canManageJobBilling(
  admin: SupabaseClient,
  userId: string,
  jobId: string
): Promise<boolean> {
  const [office, { data: assignment }] = await Promise.all([
    isOfficeOrAdmin(admin, userId),
    admin.from("job_assignments").select("staff_id").eq("job_id", jobId).eq("staff_id", userId).maybeSingle(),
  ]);

  if (office) return true;
  return !!assignment;
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
