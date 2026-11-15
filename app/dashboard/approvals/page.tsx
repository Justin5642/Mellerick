export const dynamic = "force-dynamic";

import { getViewer } from "@/lib/auth/viewer";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import type { UnbilledVariation } from "@/components/approvals/unbilled-variations";
import { ApprovalsClient, type JobHoursSummary } from "@/components/approvals/approvals-client";
import { loadJobHours, unbilledGroups } from "@/lib/invoice-hours";
import { totalHours } from "@/lib/approved-hours";

export default async function ApprovalsPage() {
  const supabase = await createClient();

  // Loaded here, next to the database, in one parallel batch with the viewer's
  // role — this used to run in the browser after hydration, followed by a
  // separate auth + profiles round trip just to learn whether to show the
  // Approve button. Columns are the ones the list renders plus what approve()
  // copies onto the invoice (customer_id, customer_po, job_number, title).
  const [viewer, { data: jobs }, { data: pendingVariations }, { data: unbilledVariations }] = await Promise.all([
    getViewer(),
    supabase
      .from("jobs")
      .select("id, job_number, title, customer_id, customer_po, completion_notes, updated_at, overtime_category, overtime_reason, overtime_logged_at, customers(name), sites(suburb), overtime_logged_by_profile:profiles!jobs_overtime_logged_by_fkey(full_name)")
      .eq("status", "completed")
      .eq("admin_status", "pending")
      .order("updated_at", { ascending: false }),
    supabase
      .from("job_variations")
      .select("id, variation_type_id, custom_name, quantity, unit, description, variation_types(name), jobs(id, job_number, title, customers(name))")
      .eq("status", "pending_approval")
      .order("created_at", { ascending: false }),
    // Approved but not on an invoice yet — the "Variations to invoice" list.
    supabase
      .from("job_variations")
      .select("id, variation_type_id, custom_name, quantity, unit, total_amount, approved_at, logged_at, variation_types(name), jobs(id, job_number, title, customer_id, customers(name), invoices(id, invoice_number, status))")
      .in("status", ["approved", "auto_approved"])
      .is("invoice_id", null)
      .order("approved_at", { ascending: true, nullsFirst: true }),
  ]);

  if (!viewer) redirect("/login");

  // The hours each job will carry onto its invoice, so the office sees them
  // BEFORE approving (Justin, 14 Nov 2026). A failed read is shown on the job,
  // not swallowed: "no hours" and "could not check" must look different.
  const jobIds = (jobs ?? []).map((j: any) => j.id as string);
  let hoursByJob: Record<string, JobHoursSummary> = {};
  try {
    const entries = await loadJobHours(supabase as any, jobIds);
    hoursByJob = Object.fromEntries(
      jobIds.map((id) => {
        const groups = unbilledGroups(entries.get(id) ?? []);
        return [id, { groups, total: totalHours(groups), error: null }];
      })
    );
  } catch (e: any) {
    hoursByJob = Object.fromEntries(jobIds.map((id) => [id, { groups: [], total: 0, error: e.message ?? "Could not load hours" }]));
  }

  return (
    <ApprovalsClient
      role={viewer.profile?.role ?? null}
      currentUserId={viewer.user.id}
      jobs={jobs ?? []}
      hoursByJob={hoursByJob}
      pendingVariations={pendingVariations ?? []}
      unbilledVariations={(unbilledVariations ?? []) as unknown as UnbilledVariation[]}
    />
  );
}
