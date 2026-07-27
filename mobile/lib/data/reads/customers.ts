import { supabase } from "../../supabase";
import { summarizeCustomerInvoices } from "../../customerSummary";
import { fromLocalOr } from "./source";
import { bool, num, numOrNull } from "./rowMap";

// Read-repository layer for customers + sites (see reads/finance.ts for the
// rationale — screens never touch supabase directly).
//
// All three reads are served from the local PowerSync DB when available,
// role-gated to office/admin (the customers area is not reachable by
// technicians; the gate forces the Supabase path — and its RLS denial — for
// anyone else). The Supabase bodies are kept verbatim inside the remote()
// closures so the fallback is byte-identical to the pre-PowerSync behaviour.
// getCustomer is local as of streams v2: the customers/sites streams carry
// `notes`, so the interface's notes fields are faithfully populated.

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

const ROLES = { roles: ["office", "admin"] as ("office" | "admin")[] };

export const SQL_LIST_CUSTOMERS = `
  SELECT id, name, company, phone, email, is_active, is_favorite
  FROM customers
  WHERE is_active = 1
    AND (?1 IS NULL OR name LIKE '%'||?1||'%' OR company LIKE '%'||?1||'%')
  ORDER BY is_favorite DESC, name COLLATE NOCASE, id
  LIMIT ? OFFSET ?`;

export const SQL_GET_CUSTOMER = `
  SELECT id, name, company, email, phone, mobile, abn, notes, is_active, is_favorite
  FROM customers WHERE id = ?`;

export const SQL_GET_CUSTOMER_SITES = `
  SELECT id, name, address_line1, address_line2, suburb, state, postcode, notes
  FROM sites WHERE customer_id = ?`;

export const SQL_CUSTOMER_JOBS = `
  SELECT id, job_number, title, status FROM jobs WHERE customer_id = ? ORDER BY created_at DESC`;

export const SQL_CUSTOMER_QUOTES = `
  SELECT id, title, status, total FROM quotes WHERE customer_id = ? ORDER BY created_at DESC`;

export const SQL_CUSTOMER_INVOICES = `
  SELECT id, title, status, total FROM invoices WHERE customer_id = ? ORDER BY created_at DESC`;

// SQLite-shaped rows: booleans arrive 1/0, numerics arrive as numbers
// (columns are declared column.real in the client schema).
interface RawCustomerListRow {
  id: string;
  name: string;
  company: string | null;
  phone: string | null;
  email: string | null;
  is_active: number;
  is_favorite: number;
}
interface RawCustomerDetailRow {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  abn: string | null;
  notes: string | null;
  is_active: number;
  is_favorite: number;
}
interface RawCustomerJobRow {
  id: string;
  job_number: number;
  title: string;
  status: string;
}
interface RawCustomerMoneyRow {
  id: string;
  title: string;
  status: string;
  total: number | null;
}

export async function listCustomers(offset: number, limit: number, query?: string): Promise<CustomerListRow[]> {
  return fromLocalOr(
    async (db) => {
      const q = (query ?? "").replace(/[,()%]/g, " ").trim();
      const rows = await db.getAll<RawCustomerListRow>(SQL_LIST_CUSTOMERS, [q === "" ? null : q, limit, offset]);
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        company: r.company,
        phone: r.phone,
        email: r.email,
        is_active: bool(r.is_active),
        is_favorite: bool(r.is_favorite),
      }));
    },
    async () => {
      // Favourites pinned to the top (matches web), then alphabetical.
      let builder = supabase.from("customers").select(LIST).eq("is_active", true).order("is_favorite", { ascending: false }).order("name").order("id");
      const q = (query ?? "").replace(/[,()%]/g, " ").trim();
      if (q) builder = builder.or(`name.ilike.%${q}%,company.ilike.%${q}%`);
      const { data } = await builder.range(offset, offset + limit - 1);
      return (data as unknown as CustomerListRow[]) ?? [];
    },
    ROLES
  );
}

export async function getCustomer(id: string): Promise<CustomerDetail | null> {
  return fromLocalOr(
    async (db) => {
      const row = await db.getOptional<RawCustomerDetailRow>(SQL_GET_CUSTOMER, [id]);
      if (!row) return null;
      const sites = await db.getAll<Site>(SQL_GET_CUSTOMER_SITES, [id]);
      return {
        id: row.id,
        name: row.name,
        company: row.company,
        email: row.email,
        phone: row.phone,
        mobile: row.mobile,
        abn: row.abn,
        notes: row.notes,
        is_active: bool(row.is_active),
        is_favorite: bool(row.is_favorite),
        sites,
      };
    },
    async () => {
      const { data } = await supabase
        .from("customers")
        .select("*, sites(id, name, address_line1, address_line2, suburb, state, postcode, notes)")
        .eq("id", id)
        .single();
      return (data as unknown as CustomerDetail) ?? null;
    },
    ROLES
  );
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
  return fromLocalOr(
    async (db) => {
      const [jobRows, quoteRows, invoiceRows] = await Promise.all([
        db.getAll<RawCustomerJobRow>(SQL_CUSTOMER_JOBS, [customerId]),
        db.getAll<RawCustomerMoneyRow>(SQL_CUSTOMER_QUOTES, [customerId]),
        db.getAll<RawCustomerMoneyRow>(SQL_CUSTOMER_INVOICES, [customerId]),
      ]);
      const invoices = invoiceRows.map((r) => ({ id: r.id, title: r.title, status: r.status, total: numOrNull(r.total) }));
      const { totalInvoiced, outstanding } = summarizeCustomerInvoices(invoices);
      return {
        jobs: jobRows.map((r) => ({ id: r.id, job_number: num(r.job_number), title: r.title, status: r.status })),
        quotes: quoteRows.map((r) => ({ id: r.id, title: r.title, status: r.status, total: numOrNull(r.total) })),
        invoices,
        totalInvoiced,
        outstanding,
      };
    },
    async () => {
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
    },
    ROLES
  );
}
