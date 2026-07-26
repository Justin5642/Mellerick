import { supabase } from "../../supabase";

// Read-repository layer for customers + sites (see reads/finance.ts for the
// rationale — screens never touch supabase directly).

export interface CustomerListRow {
  id: string;
  name: string;
  company: string | null;
  phone: string | null;
  email: string | null;
  is_active: boolean;
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
  sites: Site[];
}

const LIST = "id, name, company, phone, email, is_active";

export async function listCustomers(offset: number, limit: number, query?: string): Promise<CustomerListRow[]> {
  let builder = supabase.from("customers").select(LIST).eq("is_active", true).order("name").order("id");
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
