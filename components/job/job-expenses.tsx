"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Trash2, CheckCircle2, ExternalLink, Loader2 } from "lucide-react";
import { formatDate } from "@/lib/date";

interface Expense {
  id: string;
  supplier_name: string;
  category: string;
  description: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  amount: number;
  gst_amount: number;
  receipt_storage_path: string | null;
  xero_bill_id: string | null;
  xero_synced_at: string | null;
  created_at: string;
  cost_center_id: string | null;
}

interface CostCenterOption {
  id: string;
  name: string;
  code: string | null;
  po_number?: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  materials: "Materials",
  subcontractor: "Subcontractor",
  equipment_hire: "Equipment Hire",
  other: "Other",
};

interface Props {
  jobId: string;
  jobNumber: string;
  expenses: Expense[];
  onUpdate: (expenses: Expense[]) => void;
  currentUserId: string;
  costCenters: CostCenterOption[];
}

export function JobExpenses({ jobId, jobNumber, expenses: initialExpenses, onUpdate, currentUserId, costCenters }: Props) {
  const supabase = createClient();
  const [expenses, setExpenses] = useState<Expense[]>(initialExpenses);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pushingId, setPushingId] = useState<string | null>(null);
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [receiptDragActive, setReceiptDragActive] = useState(false);
  const [form, setForm] = useState({
    supplier_name: "",
    category: "materials",
    description: "",
    invoice_number: "",
    invoice_date: "",
    amount: "",
    gst_amount: "",
    cost_center_id: "none",
  });
  const [errors, setErrors] = useState<Record<string, boolean>>({});

  function fieldErr(field: string) {
    return errors[field] ? "border-red-500 focus-visible:ring-red-500" : "";
  }

  async function saveExpense() {
    if (!form.supplier_name.trim()) { setErrors({ supplier_name: true }); return; }
    if (!form.amount || Number(form.amount) <= 0) { setErrors({ amount: true }); return; }
    setSaving(true);

    let receiptPath: string | null = null;
    if (receiptFile) {
      receiptPath = `${jobId}/expense-receipt-${Date.now()}_${receiptFile.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const { error: uploadError } = await supabase.storage.from("job-documents").upload(receiptPath, receiptFile);
      if (uploadError) { toast.error("Failed to upload receipt"); setSaving(false); return; }
    }

    const { data, error } = await supabase
      .from("job_expenses")
      .insert({
        job_id: jobId,
        supplier_name: form.supplier_name.trim(),
        category: form.category,
        description: form.description || null,
        invoice_number: form.invoice_number || null,
        invoice_date: form.invoice_date || null,
        amount: Number(form.amount) || 0,
        gst_amount: Number(form.gst_amount) || 0,
        receipt_storage_path: receiptPath,
        entered_by: currentUserId,
        cost_center_id: form.cost_center_id === "none" ? null : form.cost_center_id,
      })
      .select()
      .single();

    if (error || !data) { toast.error("Failed to save expense"); setSaving(false); return; }

    const updated = [data as Expense, ...expenses];
    setExpenses(updated);
    onUpdate(updated);
    setShowForm(false);
    setForm({ supplier_name: "", category: "materials", description: "", invoice_number: "", invoice_date: "", amount: "", gst_amount: "", cost_center_id: "none" });
    setReceiptFile(null);
    toast.success("Expense saved");
    setSaving(false);
  }

  async function deleteExpense(expense: Expense) {
    if (expense.receipt_storage_path) {
      await supabase.storage.from("job-documents").remove([expense.receipt_storage_path]);
    }
    await supabase.from("job_expenses").delete().eq("id", expense.id);
    const updated = expenses.filter((e) => e.id !== expense.id);
    setExpenses(updated);
    onUpdate(updated);
    toast.success("Expense removed");
  }

  async function viewReceipt(expense: Expense) {
    if (!expense.receipt_storage_path) return;
    const { data } = await supabase.storage.from("job-documents").createSignedUrl(expense.receipt_storage_path, 60);
    if (data?.signedUrl) window.open(data.signedUrl, "_blank");
  }

  async function pushToXero(expense: Expense) {
    setPushingId(expense.id);
    try {
      const res = await fetch("/api/xero/push-expense", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expenseId: expense.id }),
      });
      const data = await res.json();
      if (!res.ok) { toast.error(data.error ?? "Failed to push to Xero"); return; }

      const updated = expenses.map((e) => (e.id === expense.id ? { ...e, xero_bill_id: data.xeroBillId, xero_synced_at: new Date().toISOString() } : e));
      setExpenses(updated);
      onUpdate(updated);
      toast.success("Pushed to Xero as a Bill");
    } catch {
      toast.error("Failed to push to Xero");
    } finally {
      setPushingId(null);
    }
  }

  const totalExGst = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
  const totalGst = expenses.reduce((sum, e) => sum + Number(e.gst_amount), 0);

  function costCenterLabel(id: string | null) {
    if (!id) return null;
    const cc = costCenters.find((c) => c.id === id);
    if (!cc) return null;
    return cc.po_number ? `${cc.name} (PO #${cc.po_number})` : cc.name;
  }

  return (
    <div className="p-6 space-y-6">
      {expenses.length > 0 && (
        <Card className="border-blue-100 bg-blue-50/40">
          <CardContent className="pt-4 pb-4 space-y-1">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Total Costs Logged</p>
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Ex GST</span>
              <span className="font-semibold text-slate-800">${totalExGst.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">GST</span>
              <span className="font-semibold text-slate-800">${totalGst.toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-sm pt-1 border-t">
              <span className="text-slate-600 font-medium">Total (inc GST)</span>
              <span className="font-bold text-slate-900">${(totalExGst + totalGst).toFixed(2)}</span>
            </div>
          </CardContent>
        </Card>
      )}

      {expenses.map((expense) => (
        <Card key={expense.id}>
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-2">
              <div>
                <CardTitle className="text-base">{expense.supplier_name}</CardTitle>
                <p className="text-xs text-slate-500 mt-0.5">
                  {CATEGORY_LABELS[expense.category] ?? expense.category}
                  {expense.invoice_number ? ` · Inv #${expense.invoice_number}` : ""}
                  {expense.invoice_date ? ` · ${formatDate(expense.invoice_date)}` : ""}
                </p>
                {expense.description && <p className="text-sm text-slate-600 mt-1">{expense.description}</p>}
                {costCenterLabel(expense.cost_center_id) && (
                  <span className="inline-block text-xs font-medium px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 mt-1.5">
                    {costCenterLabel(expense.cost_center_id)}
                  </span>
                )}
              </div>
              <button onClick={() => deleteExpense(expense)} className="text-slate-300 hover:text-red-400 transition-colors p-1 shrink-0">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </CardHeader>
          <CardContent className="pt-0 space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Amount (ex GST)</span>
              <span className="font-medium text-slate-800">${Number(expense.amount).toFixed(2)}</span>
            </div>
            {Number(expense.gst_amount) > 0 && (
              <div className="flex justify-between text-sm">
                <span className="text-slate-500">GST</span>
                <span className="font-medium text-slate-800">${Number(expense.gst_amount).toFixed(2)}</span>
              </div>
            )}
            <div className="flex items-center justify-between pt-2 border-t">
              {expense.receipt_storage_path ? (
                <Button variant="ghost" size="sm" className="gap-1.5 h-8 text-xs text-slate-500" onClick={() => viewReceipt(expense)}>
                  <ExternalLink className="w-3.5 h-3.5" />View receipt
                </Button>
              ) : <span />}

              {expense.xero_bill_id ? (
                <span className="flex items-center gap-1.5 text-xs font-medium text-green-700 bg-green-100 px-2.5 py-1 rounded-full">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Synced to Xero
                </span>
              ) : (
                <Button
                  variant="outline" size="sm" className="gap-1.5 h-8 text-xs"
                  onClick={() => pushToXero(expense)}
                  disabled={pushingId === expense.id}
                >
                  {pushingId === expense.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                  {pushingId === expense.id ? "Pushing..." : "Push to Xero"}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      ))}

      {showForm ? (
        <Card>
          <CardHeader><CardTitle className="text-base">New Expense</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Supplier *</Label>
                <Input
                  value={form.supplier_name}
                  onChange={(e) => { setForm((f) => ({ ...f, supplier_name: e.target.value })); setErrors({}); }}
                  placeholder="e.g. Reece Plumbing"
                  className={fieldErr("supplier_name")}
                />
                {errors.supplier_name && <p className="text-xs text-red-500">Supplier name is required</p>}
              </div>
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Select value={form.category} onValueChange={(v) => setForm((f) => ({ ...f, category: v ?? "materials" }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {costCenters.length > 0 && (
              <div className="space-y-1.5">
                <Label>Cost Centre / Stage</Label>
                <Select value={form.cost_center_id} onValueChange={(v) => setForm((f) => ({ ...f, cost_center_id: v ?? "none" }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Unassigned</SelectItem>
                    {costCenters.map((cc) => (
                      <SelectItem key={cc.id} value={cc.id}>
                        {cc.name}{cc.po_number ? ` (PO #${cc.po_number})` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-1.5">
              <Label>Description</Label>
              <Input
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="What was this for?"
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Invoice Number</Label>
                <Input
                  value={form.invoice_number}
                  onChange={(e) => setForm((f) => ({ ...f, invoice_number: e.target.value }))}
                  placeholder="Optional"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Invoice Date</Label>
                <Input
                  type="date"
                  value={form.invoice_date}
                  onChange={(e) => setForm((f) => ({ ...f, invoice_date: e.target.value }))}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Amount (ex GST) *</Label>
                <Input
                  type="number" step="0.01"
                  value={form.amount}
                  onChange={(e) => { setForm((f) => ({ ...f, amount: e.target.value })); setErrors({}); }}
                  placeholder="0.00"
                  className={fieldErr("amount")}
                />
                {errors.amount && <p className="text-xs text-red-500">Enter a valid amount</p>}
              </div>
              <div className="space-y-1.5">
                <Label>GST</Label>
                <Input
                  type="number" step="0.01"
                  value={form.gst_amount}
                  onChange={(e) => setForm((f) => ({ ...f, gst_amount: e.target.value }))}
                  placeholder="0.00"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Receipt / Invoice File</Label>
              <div
                className={`flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-4 text-center transition-colors ${
                  receiptDragActive ? "border-blue-400 bg-blue-50/40 text-blue-500" : "border-slate-200 text-slate-400"
                }`}
                onDragOver={(e) => { e.preventDefault(); setReceiptDragActive(true); }}
                onDragLeave={(e) => { e.preventDefault(); setReceiptDragActive(false); }}
                onDrop={(e) => {
                  e.preventDefault();
                  setReceiptDragActive(false);
                  const file = e.dataTransfer.files?.[0];
                  if (file) setReceiptFile(file);
                }}
              >
                {receiptFile ? (
                  <p className="text-sm text-slate-700">{receiptFile.name}</p>
                ) : (
                  <p className="text-xs">{receiptDragActive ? "Drop to attach" : "Drag and drop an invoice/receipt here, or"}</p>
                )}
                <input
                  type="file"
                  accept=".pdf,.png,.jpg,.jpeg"
                  onChange={(e) => setReceiptFile(e.target.files?.[0] ?? null)}
                  className="text-sm text-slate-500 file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border-0 file:text-xs file:font-medium file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" onClick={() => { setShowForm(false); setReceiptFile(null); }}>Cancel</Button>
              <Button type="button" onClick={saveExpense} disabled={saving}>
                {saving ? "Saving..." : "Save Expense"}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Button variant="outline" className="gap-2" onClick={() => setShowForm(true)}>
          <Plus className="w-4 h-4" />Add Expense
        </Button>
      )}
    </div>
  );
}
