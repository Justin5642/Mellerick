export const dynamic = "force-dynamic";

import { getViewer } from "@/lib/auth/viewer";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import type { UnbilledVariation } from "@/components/approvals/unbilled-variations";
import { ApprovalsClient, type JobHoursSummary } from "@/components/approvals/approvals-client";
import { approvalHoursByJob } from "@/lib/invoice-hours";
import Link from "next/link";

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
  // Same read the phone uses (GET /api/approvals/hours).
  const hoursByJob: Record<string, JobHoursSummary> = await approvalHoursByJob(supabase as any, jobIds);

  // Mistakes waiting for the office to cost and close (0119, a draft not applied yet) — office/admin.
  // Before 0119 (no status column) or on any error the banner is left out.
  const role = viewer.profile?.role ?? null;
  let openMistakes = 0;
  if (role === "office" || role === "admin") {
    const { count, error } = await supabase.from("job_mistakes").select("id", { count: "exact", head: true }).neq("status", "closed");
    if (!error) openMistakes = count ?? 0;
  }

  return (
    <>
    {openMistakes > 0 && (
      <div className="mx-6 mt-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 flex flex-wrap items-center justify-between gap-2">
        <span>
          {openMistakes} mistake{openMistakes === 1 ? "" : "s"} to review — cost them, record any money back and close them.
        </span>
        <Link href="/dashboard/reports/mistakes" className="font-medium underline">
          Review mistakes
        </Link>
      </div>
    )}
    <ApprovalsClient
      role={viewer.profile?.role ?? null}
      currentUserId={viewer.user.id}
      jobs={jobs ?? []}
      hoursByJob={hoursByJob}
      pendingVariations={pendingVariations ?? []}
      unbilledVariations={(unbilledVariations ?? []) as unknown as UnbilledVariation[]}
    />
    </>
  );
}
