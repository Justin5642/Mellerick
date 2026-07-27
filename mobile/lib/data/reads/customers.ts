import { supabase } from "../../supabase";
import { summarizeCustomerInvoices } from "../../customerSummary";

// Read-repository layer for customers + sites (see reads/finance.ts for the
// rationale — screens never touch supabase directly).

export interface CustomerListRow {
  id: string;
  name: string;
  company: string | null;
  phone: string | null;
  email: string | null;
  is_active: boolean;
  is_favorite: boolean;
}
export interface Site {
  id: string;
  name: string;
  address_line1: string;
  address_line2: string | null;
  suburb: string;
  state: string;
  postcode: string;
  notes: string | null;
}
export interface CustomerDetail {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  abn: string | null;
  notes: string | null;
  is_active: boolean;
  is_favorite: boolean;
  sites: Site[];
}

const LIST = "id, name, company, phone, email, is_active, is_favorite";

export async function listCustomers(offset: number, limit: number, query?: string): Promise<CustomerListRow[]> {
  // Favourites pinned to the top (matches web), then alphabetical.
  let builder = supabase.from("customers").select(LIST).eq("is_active", true).order("is_favorite", { ascending: false }).order("name").order("id");
  const q = (query ?? "").replace(/[,()%]/g, " ").trim();
  if (q) builder = builder.or(`name.ilike.%${q}%,company.ilike.%${q}%`);
  const { data } = await builder.range(offset, offset + limit - 1);
  return (data as unknown as CustomerListRow[]) ?? [];
}

export async function getCustomer(id: string): Promise<CustomerDetail | null> {
  const { data } = await supabase
    .from("customers")
    .select("*, sites(id, name, address_line1, address_line2, suburb, state, postcode, notes)")
    .eq("id", id)
    .single();
  return (data as unknown as CustomerDetail) ?? null;
}

export interface CustomerJob { id: string; job_number: number; title: string; status: string }
export interface CustomerQuote { id: string; title: string; status: string; total: number | null }
export interface CustomerInvoice { id: string; title: string; status: string; total: number | null }
export interface CustomerOverview {
  jobs: CustomerJob[];
  quotes: CustomerQuote[];
  invoices: CustomerInvoice[];
  totalInvoiced: number;
  outstanding: number;
}

// Customer-360: the customer's recent jobs/quotes/invoices + a financial
// rollup (total invoiced / outstanding). Office/admin only — the customers
// area is not reachable by technicians.
export async function getCustomerOverview(customerId: string): Promise<CustomerOverview> {
  const [jobsRes, quotesRes, invoicesRes] = await Promise.all([
    // No limit — the section counts must match the web's true totals; the screen
    // itself slices to the first few for display.
    supabase.from("jobs").select("id, job_number, title, status").eq("customer_id", customerId).order("created_at", { ascending: false }),
    supabase.from("quotes").select("id, title, status, total").eq("customer_id", customerId).order("created_at", { ascending: false }),
    supabase.from("invoices").select("id, title, status, total").eq("customer_id", customerId).order("created_at", { ascending: false }),
  ]);
  const invoices = (invoicesRes.data as unknown as CustomerInvoice[]) ?? [];
  const { totalInvoiced, outstanding } = summarizeCustomerInvoices(invoices);
  return {
    jobs: (jobsRes.data as unknown as CustomerJob[]) ?? [],
    quotes: (quotesRes.data as unknown as CustomerQuote[]) ?? [],
    invoices,
    totalInvoiced,
    outstanding,
  };
}
