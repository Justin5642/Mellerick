"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { INVOICE_TERM_DAYS, dueDateForTerm, termForDueDate } from "@/lib/invoice-terms";

// Payment terms (14 / 30 days) beside the due date, on New and Edit Invoice.
// Picking a term fills the due date from the invoice date; typing a date by
// hand shows "Custom date". Only due_date is saved.
export function PaymentTermsField({
  dueDate,
  invoiceDay,
  onChange,
}: {
  dueDate: string;
  /** The invoice date (YYYY-MM-DD, Melbourne) the terms count from. */
  invoiceDay: string;
  onChange: (dueDate: string) => void;
}) {
  const term = termForDueDate(dueDate, invoiceDay);
  return (
    <div className="space-y-2">
      <Label htmlFor="payment_terms">Payment terms</Label>
      <div className="flex gap-2">
        <select
          id="payment_terms"
          value={dueDate ? String(term) : ""}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "") onChange("");
            else if (v !== "custom") onChange(dueDateForTerm(Number(v), invoiceDay));
          }}
          className="h-9 rounded-md border border-slate-200 bg-white px-2 text-sm"
        >
          <option value="">No due date</option>
          {INVOICE_TERM_DAYS.map((n) => (
            <option key={n} value={n}>{n} days</option>
          ))}
          <option value="custom" disabled={!dueDate || term !== "custom"}>Custom date</option>
        </select>
        <Input
          type="date"
          aria-label="Due date"
          value={dueDate}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1"
        />
      </div>
    </div>
  );
}
