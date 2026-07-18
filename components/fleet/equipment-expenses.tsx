"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Trash2, ExternalLink } from "lucide-react";
import { formatDate } from "@/lib/date";

// The real dated expense/service history for a vehicle -- as distinct
// from the equipment.* cost profile (migration 0016), which only holds
// *estimated* annual figures for the $/hour job-costing calculation.
// Mirrors components/job/job-expenses.tsx's receipt-upload pattern, but
// against equipment_expenses (migration 0023) and the equipment-documents
// bucket, with no cost-centre/Xero push since those are job-specific.

interface Expense {
  id: string;
  category: string;
  supplier_name: string | null;
  description: string | null;
  invoice_number: string | null;
  expense_date: string;
  amount: number;
  gst_amount: number;
  receipt_storage_path: string | null;
  created_at: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  service: "Service",
  repair: "Repair",
  fuel: "Fuel",
  tyres: "Tyres",
  registration: "Registration",
  insurance: "Insurance",
  other: "Other",
};

interface Props {
  equipmentId: string;
  expenses: Expense[];
  onUpdate: (expenses: Expense[]) => void;
  currentUserId: string;
}

export function EquipmentExpenses({ equipmentId, expenses: initialExpenses, onUpdate, currentUserId }: Props) {
  const supabase = createClient();
  const [expenses, setExpenses] = useState<Expense[]>(initialExpenses);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [receiptDragActive, setReceiptDragActive] = useState(false);
  const [form, setForm] = useState({
    category: "service",
    supplier_name: "",
    description: "",
    invoice_number: "",
    expense_date: new Date().toISOString().slice(0, 10),
    amount: "",
    gst_amount: "",
  });
  const [errors, setErrors] = useState<Record<string, boolean>>({});

  function fieldErr(field: string) {
    return errors[field] ? "border-red-500 focus-visible:ring-red-500" : "";
  }

  async function saveExpense() {
    if (!form.amount || Number(form.amount) <= 0) { setErrors({ amount: true }); return; }
    setSaving(true);

    let receiptPath: string | null = null;
    if (receiptFile) {
      receiptPath = `${equipmentId}/expense-receipt-${Date.now()}_${receiptFile.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const { error: uploadError } = await supabase.storage.from("equipment-documents").upload(receiptPath, receiptFile);
      if (uploadError) { toast.error("Failed to upload receipt"); setSaving(false); return; }
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();

    const { data, error } = await supabase
      .from("equipment_expenses")
      .insert({
        equipment_id: equipmentId,
        category: form.category,
        supplier_name: form.supplier_name || null,
        description: form.description || null,
        invoice_number: form.invoice_number || null,
        expense_date: form.expense_date || new Date().toISOString().slice(0, 10),
        amount: Number(form.amount) || 0,
        gst_amount: Number(form.gst_amount) || 0,
        receipt_storage_path: receiptPath,
        logged_by: user?.id ?? currentUserId,
      })
      .select()
      .single();

    if (error || !data) { toast.error("Failed to save expense"); setSaving(false); return; }

    const updated = [data as Expense, ...expenses].sort((a, b) => (a.expense_date < b.expense_date ? 1 : -1));
    setExpenses(updated);
    onUpdate(updated);
    setShowForm(false);
    setForm({ category: "service", supplier_name: "", description: "", invoice_number: "", expense_date: new Date().toISOString().slice(0, 10), amount: "", gst_amount: "" });
    setReceiptFile(null);
    toast.success("Expense saved");
    setSaving(false);
  }

  async function deleteExpense(expense: Expense) {
    if (expense.receipt_storage_path) {
      await supabase.storage.from("equipment-documents").remove([expense.receipt_storage_path]);
    }
    await supabase.from("equipment_expenses").delete().eq("id", expense.id);
    const updated = expenses.filter((e) => e.id !== expense.id);
    setExpenses(updated);
    onUpdate(updated);
    toast.success("Expense removed");
  }

  async function viewReceipt(expense: Expense) {
    if (!expense.receipt_storage_path) return;
    const { data } = await supabase.storage.from("equipment-documents").createSignedUrl(expense.receipt_storage_path, 60);
    if (data?.signedUrl) window.open(data.signedUrl, "_blank");
  }

  const totalExGst = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
  const totalGst = expenses.reduce((sum, e) => sum + Number(e.gst_amount), 0);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Expenses &amp; Service History</h2>
          <p className="text-sm text-slate-500">Actual spend on this vehicle — servicing, repairs, tyres, rego, insurance</p>
        </div>
        {!showForm && (
          <Button variant="outline" className="gap-2" onClick={() => setShowForm(true)}>
            <Plus className="w-4 h-4" />Add Expense
          </Button>
        )}
      </div>

      {expenses.length > 0 && (
        <Card className="border-blue-100 bg-blue-50/40">
          <CardContent className="pt-4 pb-4 space-y-1">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Total Logged</p>
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

      {showForm && (
        <Card>
          <CardHeader><CardTitle className="text-base">New Expense</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Select value={form.category} onValueChange={(v) => setForm((f) => ({ ...f, category: v ?? "service" }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Date</Label>
                <Input type="date" value={form.expense_date} onChange={(e) => setForm((f) => ({ ...f, expense_date: e.target.value }))} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Supplier</Label>
                <Input
                  value={form.supplier_name}
                  onChange={(e) => setForm((f) => ({ ...f, supplier_name: e.target.value }))}
                  placeholder="e.g. Toyota Service Centre"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Invoice Number</Label>
                <Input
                  value={form.invoice_number}
                  onChange={(e) => setForm((f) => ({ ...f, invoice_number: e.target.value }))}
                  placeholder="Optional"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Description</Label>
              <Input
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="What was done? e.g. 60,000km service, brake pads"
              />
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
      )}

      {expenses.length === 0 && !showForm ? (
        <div className="flex flex-col items-center justify-center py-16 text-slate-400 border-2 border-dashed border-slate-200 rounded-xl">
          <p className="text-sm font-medium">No expenses logged yet</p>
          <p className="text-xs mt-1">Add the first service, repair or renewal above</p>
        </div>
      ) : (
        <div className="space-y-3">
          {expenses.map((expense) => (
            <Card key={expense.id}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-base">{expense.supplier_name || CATEGORY_LABELS[expense.category]}</CardTitle>
                      <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                        {CATEGORY_LABELS[expense.category] ?? expense.category}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {formatDate(expense.expense_date)}
                      {expense.invoice_number ? ` · Inv #${expense.invoice_number}` : ""}
                    </p>
                    {expense.description && <p className="text-sm text-slate-600 mt-1">{expense.description}</p>}
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
                {expense.receipt_storage_path && (
                  <div className="flex items-center pt-2 border-t">
                    <Button variant="ghost" size="sm" className="gap-1.5 h-8 text-xs text-slate-500" onClick={() => viewReceipt(expense)}>
                      <ExternalLink className="w-3.5 h-3.5" />View receipt
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
