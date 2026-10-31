"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Plus, RefreshCw, Loader2 } from "lucide-react";
import Link from "next/link";
import { ListPageSkeleton } from "@/components/ui/loading-skeletons";

// Supplier accounts (migration 0087, DRAFT, not applied yet) — the list the crew picks from when they
// raise a PO. Copied from Xero (nightly, or the button here); Xero owns the
// name, account number and phone of those. The ordering email and default
// cost centre are set here. Suppliers not in Xero can be added by hand.

interface Supplier {
  id: string;
  name: string;
  account_number: string | null;
  email: string | null;
  phone: string | null;
  default_cost_centre_id: string | null;
  xero_contact_id: string | null;
  is_active: boolean;
}

interface CostCentre {
  id: string;
  name: string;
}

const COLS = "id, name, account_number, email, phone, default_cost_centre_id, xero_contact_id, is_active";

export default function SuppliersPage() {
  const supabase = createClient();
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [centres, setCentres] = useState<CostCentre[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", phone: "", account_number: "" });
  const [saving, setSaving] = useState(false);

  async function load() {
    const [s, c] = await Promise.all([
      supabase.from("suppliers").select(COLS).order("name"),
      supabase.from("cost_centres").select("id, name").eq("is_active", true).order("sort_order"),
    ]);
    setLoadFailed(!!(s.error || c.error));
    setSuppliers((s.data as Supplier[]) ?? []);
    setCentres((c.data as CostCentre[]) ?? []);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function copyFromXero() {
    setSyncing(true);
    try {
      const res = await fetch("/api/xero/sync-suppliers", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.error ?? "Couldn't copy suppliers from Xero.");
      } else {
        toast.success(`Copied ${body.total} supplier${body.total === 1 ? "" : "s"} from Xero (${body.added} new)`);
        await load();
      }
    } catch {
      toast.error("Couldn't reach the server. Check your connection.");
    }
    setSyncing(false);
  }

  async function update(id: string, patch: Partial<Supplier>) {
    const { error, count } = await supabase
      .from("suppliers")
      .update({ ...patch, updated_at: new Date().toISOString() }, { count: "exact" })
      .eq("id", id);
    if (error || count === 0) {
      toast.error("Couldn't save that change.");
      return;
    }
    setSuppliers((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  async function addSupplier(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      toast.error("Supplier name is required");
      return;
    }
    setSaving(true);
    const { error } = await supabase.from("suppliers").insert({
      name: form.name.trim(),
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      account_number: form.account_number.trim() || null,
    });
    setSaving(false);
    if (error) {
      toast.error("Couldn't add the supplier.");
      return;
    }
    toast.success("Supplier added");
    setForm({ name: "", email: "", phone: "", account_number: "" });
    setShowForm(false);
    load();
  }

  if (loading) return <ListPageSkeleton />;

  const q = search.trim().toLowerCase();
  const shown = suppliers.filter(
    (s) => (showInactive || s.is_active) && (!q || s.name.toLowerCase().includes(q) || (s.account_number ?? "").toLowerCase().includes(q))
  );

  return (
    <div className="p-6 max-w-4xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/settings">
          <Button variant="ghost" size="sm" className="gap-2 text-slate-500">
            <ArrowLeft className="w-4 h-4" /> Back
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-slate-900">Suppliers</h1>
          <p className="text-slate-500 text-sm mt-0.5">
            The list the crew picks from when they raise a purchase order. Copied from Xero every night. Set the ordering
            email and the usual cost centre here (e.g. the quarry → Transport).
          </p>
        </div>
        <Button variant="outline" className="gap-2" onClick={copyFromXero} disabled={syncing}>
          {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Copy from Xero
        </Button>
      </div>

      {loadFailed && <p className="text-sm text-red-600">Couldn&apos;t load suppliers. Refresh the page to try again.</p>}

      <div className="flex items-center gap-3">
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search suppliers" className="max-w-xs" />
        <label className="flex items-center gap-1.5 text-sm text-slate-500">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show inactive
        </label>
        <span className="text-xs text-slate-400 ml-auto">{shown.length} shown</span>
      </div>

      <Card>
        <CardContent className="p-0">
          {shown.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-10">
              {suppliers.length === 0 ? "No suppliers yet. Press Copy from Xero to bring them across." : "No suppliers match."}
            </p>
          ) : (
            <div className="divide-y divide-slate-100">
              {shown.map((s) => (
                <div key={s.id} className={`grid grid-cols-12 gap-3 items-center px-4 py-2.5 ${!s.is_active ? "opacity-50" : ""}`}>
                  <div className="col-span-4 min-w-0">
                    <p className="text-sm font-medium text-slate-800 truncate">{s.name}</p>
                    <p className="text-xs text-slate-400 truncate">
                      {[s.account_number && `Acct ${s.account_number}`, s.phone, s.xero_contact_id ? "Xero" : "Added here"].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                  <Input
                    key={`${s.id}-email-${s.email ?? ""}`}
                    defaultValue={s.email ?? ""}
                    placeholder="Ordering email"
                    className="col-span-4 h-8 text-sm"
                    onBlur={(e) => {
                      const v = e.target.value.trim() || null;
                      if (v !== s.email) update(s.id, { email: v });
                    }}
                  />
                  <select
                    value={s.default_cost_centre_id ?? ""}
                    onChange={(e) => update(s.id, { default_cost_centre_id: e.target.value || null })}
                    className="col-span-3 h-8 rounded-md border border-slate-200 bg-white px-2 text-sm"
                  >
                    <option value="">No usual cost centre</option>
                    {centres.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                  <div className="col-span-1 text-right">
                    {/* Xero decides whether its suppliers are active; the nightly copy would undo a change here. */}
                    {!s.xero_contact_id && (
                      <button onClick={() => update(s.id, { is_active: !s.is_active })} className="text-xs text-slate-400 hover:text-slate-600 underline">
                        {s.is_active ? "Hide" : "Show"}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {showForm ? (
        <Card>
          <CardHeader><CardTitle className="text-base">Add a supplier not in Xero</CardTitle></CardHeader>
          <CardContent>
            <form onSubmit={addSupplier} className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5 col-span-2">
                <Label>Name *</Label>
                <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>Ordering email</Label>
                <Input type="email" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>Phone</Label>
                <Input value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label>Our account number</Label>
                <Input value={form.account_number} onChange={(e) => setForm((f) => ({ ...f, account_number: e.target.value }))} />
              </div>
              <div className="col-span-2 flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
                <Button type="submit" disabled={saving}>{saving ? "Saving..." : "Add Supplier"}</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : (
        <Button variant="outline" className="gap-2" onClick={() => setShowForm(true)}>
          <Plus className="w-4 h-4" /> Add a supplier not in Xero
        </Button>
      )}
    </div>
  );
}
