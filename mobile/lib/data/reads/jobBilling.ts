import { supabase } from "../../supabase";

export interface JobLineItem {
  id: string;
  name: string;
  description: string | null;
  quantity: number;
  unit_price: number;
  total: number;
}
export interface JobExpense {
  id: string;
  supplier_name: string;
  category: string;
  description: string | null;
  amount: number;
  gst_amount: number;
  invoice_date: string | null;
}
export interface JobPOCostCentre {
  id: string;
  name: string;
  allocated_amount: number;
}
export interface JobPO {
  id: string;
  po_number: string;
  client_reference: string | null;
  total_value: number;
  po_cost_centers: JobPOCostCentre[];
}
export interface JobBilling {
  jobNumber: number | null;
  jobTitle: string;
  lineItems: JobLineItem[];
  expenses: JobExpense[];
  purchaseOrders: JobPO[];
}

export async function getJobBilling(jobId: string): Promise<JobBilling | null> {
  const [jobRes, itemsRes, expRes, poRes] = await Promise.all([
    supabase.from("jobs").select("job_number, title").eq("id", jobId).single(),
    supabase.from("job_items").select("id, name, description, quantity, unit_price, total").eq("job_id", jobId).order("created_at"),
    supabase.from("job_expenses").select("id, supplier_name, category, description, amount, gst_amount, invoice_date").eq("job_id", jobId).order("created_at", { ascending: false }),
    supabase.from("purchase_orders").select("id, po_number, client_reference, total_value, po_cost_centers(id, name, allocated_amount)").eq("job_id", jobId),
  ]);
  const job = jobRes.data as { job_number: number | null; title: string } | null;
  if (!job) return null;
  return {
    jobNumber: job.job_number,
    jobTitle: job.title,
    lineItems: (itemsRes.data as unknown as JobLineItem[]) ?? [],
    expenses: (expRes.data as unknown as JobExpense[]) ?? [],
    purchaseOrders: (poRes.data as unknown as JobPO[]) ?? [],
  };
}
