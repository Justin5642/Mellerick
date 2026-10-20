export const dynamic = "force-dynamic";

import { getViewer } from "@/lib/auth/viewer";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import type { UnbilledVariation } from "@/components/approvals/unbilled-variations";
import { ApprovalsClient } from "@/components/approvals/approvals-client";

export default async function ApprovalsPage() {
  const supabase = await createClient();

  // Loaded here, next to the database, in one parallel batch with the viewer's
  // role — this used to run in the browser after hydration, followed by a
  // separate auth + profiles round trip just to learn whether to show the
  // Approve button. Columns are the ones the list renders plus what approve()
  // copies onto the invoice (customer_id, job_number, title).
  const [viewer, { data: jobs }, { data: pendingVariations }, { data: unbilledVariations }] = await Promise.all([
    getViewer(),
    supabase
      .from("jobs")
      .select("id, job_number, title, customer_id, completion_notes, updated_at, overtime_category, overtime_reason, overtime_logged_at, customers(name), sites(suburb), overtime_logged_by_profile:profiles!jobs_overtime_logged_by_fkey(full_name)")
      .eq("status", "completed")
      .eq("admin_status", "pending")
      .order("updated_at", { ascending: false }),
    supabase
      .from("job_variations")
      .select("id, custom_name, quantity, unit, description, variation_types(name), jobs(id, job_number, title, customers(name))")
      .eq("status", "pending_approval")
      .order("created_at", { ascending: false }),
    // Approved but not on an invoice yet — the "Variations to invoice" list.
    supabase
      .from("job_variations")
      .select("id, custom_name, quantity, unit, total_amount, approved_at, logged_at, variation_types(name), jobs(id, job_number, title, customer_id, customers(name), invoices(id, invoice_number, status))")
      .in("status", ["approved", "auto_approved"])
      .is("invoice_id", null)
      .order("approved_at", { ascending: true, nullsFirst: true }),
  ]);

  if (!viewer) redirect("/login");

  return (
    <ApprovalsClient
      role={viewer.profile?.role ?? null}
      currentUserId={viewer.user.id}
      jobs={jobs ?? []}
      pendingVariations={pendingVariations ?? []}
      unbilledVariations={(unbilledVariations ?? []) as unknown as UnbilledVariation[]}
    />
  );
}
