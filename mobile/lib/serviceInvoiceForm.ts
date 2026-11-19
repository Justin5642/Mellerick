// MIRROR of the web's lib/service-invoice-form.ts: what the service-invoice
// reader found, put into the "Log a service" form — only fields still empty
// (or on their defaults). Body identical, pinned by
// tests/unit/fleet-mobile-mirror.test.ts. Change the web file first.

export interface ServiceFormFields {
  service_date: string;
  service_type: string;
  odometer_km: string;
  engine_hours: string;
  provider: string;
  work_done: string;
  next_due_date: string;
  next_due_km: string;
  next_due_hours: string;
  expense: string;
  amount: string;
  gst_amount: string;
  invoice_number: string;
}

/** What the read route returns (lib/service-invoice-read.ts ServiceInvoiceRead). */
export interface ServiceInvoiceReadResult {
  is_service_invoice: boolean;
  provider: string | null;
  invoice_number: string | null;
  service_date: string | null;
  amount_ex_gst: number | null;
  gst_amount: number | null;
  odometer_km: number | null;
  engine_hours: number | null;
  service_type: string;
  work_done: string | null;
  next_due_date: string | null;
  next_due_km: number | null;
  next_due_hours: number | null;
  vehicle_text: string | null;
}

export const DEFAULT_SERVICE_TYPE = "scheduled";

export function applyServiceInvoiceRead<F extends ServiceFormFields>(
  form: F,
  read: ServiceInvoiceReadResult,
  today: string,
  newExpenseValue: string,
): { form: F; filled: string[] } {
  const next = { ...form };
  const filled: string[] = [];
  const put = (key: keyof ServiceFormFields, value: string | number | null, replaceable?: string) => {
    if (value === null || value === "") return;
    const current = String(next[key] ?? "").trim();
    if (current !== "" && current !== replaceable) return;
    (next as ServiceFormFields)[key] = String(value);
    filled.push(key);
  };

  put("service_date", read.service_date, today);
  put("service_type", read.service_type, DEFAULT_SERVICE_TYPE);
  put("provider", read.provider);
  put("odometer_km", read.odometer_km);
  put("engine_hours", read.engine_hours);
  put("work_done", read.work_done);
  put("next_due_date", read.next_due_date);
  put("next_due_km", read.next_due_km);
  put("next_due_hours", read.next_due_hours);
  put("amount", read.amount_ex_gst);
  put("gst_amount", read.gst_amount);
  put("invoice_number", read.invoice_number);

  // An invoice with a cost means the cost is being logged now — unless the
  // office already linked an existing expense.
  if (read.amount_ex_gst !== null && (next.expense === "" || next.expense === newExpenseValue)) {
    next.expense = newExpenseValue;
  }
  return { form: next, filled };
}
