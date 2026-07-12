"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function XeroExpenseAccountCode({ initialValue }: { initialValue: string | null }) {
  const [value, setValue] = useState(initialValue ?? "");
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch("/api/xero/expense-account-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountCode: value.trim() }),
      });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error ?? "Failed to save");
        return;
      }
      toast.success("Saved");
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-1.5 pt-3 border-t">
      <Label htmlFor="expenseAccountCode">Job Expense Account Code</Label>
      <p className="text-xs text-slate-500">
        Chart-of-accounts code that job expenses (materials, subcontractors, equipment hire) get coded to when pushed to Xero as a Bill.
      </p>
      <div className="flex gap-2 max-w-xs">
        <Input id="expenseAccountCode" value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. 310" className="font-mono" />
        <Button variant="outline" size="sm" onClick={handleSave} disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}
