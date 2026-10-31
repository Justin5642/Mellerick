export const dynamic = "force-dynamic";

import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

// Where a supplier invoice gets matched (Stage 4, 31 Oct 2026: "When a
// supplier invoice arrives quoting the PO number, it should be easy to attach
// it to the right job and cost line"). Type the PO number off the invoice and
// open the order on its job's PO tab, where the invoice is entered once and
// sent to Xero as a bill. Below the search: every live order still waiting
// for its invoice, oldest first.
//
// Office/admin only: vendor_orders RLS (0061) returns nothing to anyone else,
// and the nav hides the page from technicians.

interface OrderRow {
  id: string;
  po_number: string;
  vendor_name: string;
  status: string;
  order_date: string | null;
  created_at: string;
  invoice_number: string | null;
  amount: number | null;
  xero_bill_id: string | null;
  delivered_at: string | null;
  jobs: { id: string; job_number: number; title: string } | null;
  po_cost_centers: { name: string } | null;
}

const COLS =
  "id, po_number, vendor_name, status, order_date, created_at, invoice_number, amount, xero_bill_id, delivered_at, " +
  "jobs(id, job_number, title), po_cost_centers(name)";

export default async function SupplierPosPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q: rawQ } = await searchParams;
  const q = (rawQ ?? "").trim();
  const supabase = await createClient();

  // "1234", "po1234", "PO-1234" all find PO-1234.
  const digits = q.replace(/\D/g, "");
  const [found, waiting] = await Promise.all([
    q
      ? supabase.from("vendor_orders").select(COLS).or(`po_number.ilike.%${digits || q.replace(/[,()]/g, "")}%,vendor_name.ilike.%${q.replace(/[,()]/g, "")}%`).order("created_at", { ascending: false }).limit(25)
      : Promise.resolve({ data: null, error: null }),
    supabase.from("vendor_orders").select(COLS).is("invoice_number", null).neq("status", "cancelled").order("created_at", { ascending: true }).limit(200),
  ]);
  const loadFailed = !!(found.error || waiting.error);
  if (loadFailed) console.error("supplier POs load failed:", found.error ?? waiting.error);

  const table = (rows: OrderRow[], empty: string) =>
    rows.length === 0 ? (
      <p className="text-sm text-slate-400 text-center py-8">{empty}</p>
    ) : (
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs text-slate-500">
          <tr>
            <th className="text-left font-medium px-4 py-2">PO</th>
            <th className="text-left font-medium px-4 py-2">Supplier</th>
            <th className="text-left font-medium px-4 py-2">Job · cost centre</th>
            <th className="text-left font-medium px-4 py-2">Raised</th>
            <th className="text-left font-medium px-4 py-2">Invoice</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((o) => (
            <tr key={o.id}>
              <td className="px-4 py-2.5 font-mono font-semibold text-slate-800">
                {o.jobs ? <Link href={`/dashboard/jobs/${o.jobs.id}?tab=po`} className="hover:underline">{o.po_number}</Link> : o.po_number}
              </td>
              <td className="px-4 py-2.5 text-slate-700">{o.vendor_name}</td>
              <td className="px-4 py-2.5 text-slate-600">
                {o.jobs ? `#${o.jobs.job_number} — ${o.jobs.title}` : "—"}
                {o.po_cost_centers?.name && <span className="block text-xs text-slate-400">{o.po_cost_centers.name}</span>}
              </td>
              <td className="px-4 py-2.5 text-slate-500">
                {o.order_date ?? o.created_at.slice(0, 10)}
                {o.delivered_at && <span className="block text-xs text-green-700">delivered</span>}
                {o.status === "cancelled" && <span className="block text-xs text-slate-400">cancelled</span>}
              </td>
              <td className="px-4 py-2.5 text-slate-600">
                {o.invoice_number ? (
                  <>
                    <span className="font-mono">{o.invoice_number}</span> · ${Number(o.amount ?? 0).toFixed(2)}
                    <span className={`block text-xs ${o.xero_bill_id ? "text-green-700" : "text-amber-600"}`}>
                      {o.xero_bill_id ? "In Xero" : "Not sent to Xero"}
                    </span>
                  </>
                ) : (
                  <span className="text-amber-600">Waiting</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Supplier POs</h1>
        <p className="text-slate-500 text-sm mt-0.5">
          Got a supplier invoice? Type the PO number on it, open the job, and enter the invoice against that PO. It then
          goes to Xero as a bill from there.
        </p>
      </div>

      <form className="flex gap-2 max-w-md" action="/dashboard/supplier-pos">
        <Input name="q" defaultValue={q} placeholder="PO number (e.g. 1234) or supplier" autoFocus />
        <Button type="submit">Find</Button>
      </form>

      {loadFailed && <p className="text-sm text-red-600">Couldn&apos;t load supplier POs. Refresh to try again.</p>}

      {q && (
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            {table((found.data ?? []) as unknown as OrderRow[], `No PO matches "${q}".`)}
          </CardContent>
        </Card>
      )}

      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-slate-700">Waiting for the supplier&apos;s invoice ({(waiting.data ?? []).length})</h2>
        <Card>
          <CardContent className="p-0 overflow-x-auto">
            {table((waiting.data ?? []) as unknown as OrderRow[], "Every PO has its invoice entered.")}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
