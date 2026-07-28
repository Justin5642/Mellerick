// DELIBERATELY SUPABASE-ONLY — no fromLocalOr / LocalReads path in this module.
// All three tables read here ARE office-synced, but getApprovalPlan is a
// pre-write consistency read: existingInvoiceId is the duplicate-invoice guard.
// A stale local DB returning null would create a second invoice. Reading this
// locally trades a correctness invariant for an offline convenience on a flow
// that already requires the network. Pinned by supabaseOnly.test.ts.

import { supabase } from "../../supabase";
import type { LineItemInput } from "../repositories/finance";

export interface ApprovalPlan {
  jobId: string;
  customerId: string;
  jobNumber: number;
  jobTitle: string;
  /** An invoice already linked to this job (dup guard), or null. */
  existingInvoiceId: string | null;
  /** The job's built-up line items to seed a new invoice from. */
  items: LineItemInput[];
}

// Read the state an admin needs to approve a job: the job's customer/number/
// title, whether an invoice already exists for it, and its line items. Called
// at approve time (online) — mirrors the web approve()'s pre-reads.
export async function getApprovalPlan(jobId: string): Promise<ApprovalPlan | null> {
  const [jobRes, invRes, itemsRes] = await Promise.all([
    supabase.from("jobs").select("customer_id, job_number, title").eq("id", jobId).single(),
    supabase.from("invoices").select("id").eq("job_id", jobId).maybeSingle(),
    supabase.from("job_items").select("name, description, quantity, unit_price").eq("job_id", jobId).order("created_at"),
  ]);
  const job = jobRes.data as { customer_id: string; job_number: number; title: string } | null;
  if (!job) return null;
  const inv = invRes.data as { id: string } | null;
  const rows = (itemsRes.data as unknown as { name: string; description: string | null; quantity: number; unit_price: number }[]) ?? [];
  return {
    jobId,
    customerId: job.customer_id,
    jobNumber: job.job_number,
    jobTitle: job.title,
    existingInvoiceId: inv?.id ?? null,
    items: rows.map((i) => ({ name: i.name, description: i.description, quantity: Number(i.quantity), unitPrice: Number(i.unit_price) })),
  };
}
