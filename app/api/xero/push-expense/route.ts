import { NextRequest, NextResponse } from "next/server";
import { getRefreshedXero, describeXeroError } from "@/lib/xero";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { Invoice, LineItem, Contact, LineAmountTypes } from "xero-node";

// Manual, per-expense "push to Xero" action — same pattern/UX as the
// existing /api/xero/push-invoice (manual button, never automatic). Creates
// a Xero Bill (ACCPAY) for the supplier, coded to the office-configured
// default_expense_account_code, with the job number in the Reference field
// so the cost is identifiable per job in Xero reporting.

export async function POST(request: NextRequest) {
  try {
    const { expenseId } = await request.json();

    // Was auth'd only by getUser() (any logged-in user) — a technician holding a
    // session could push a supplier expense to Xero. Now office/admin-only (Bearer
    // or cookie), consistent with the rest of the money surface. Whether it should
    // be admin-only like push-invoice is a business call — see Q21.
    const guard = await requireOfficeOrAdmin(request);
    if (!guard.ok) return guard.response;
    const supabase = await callerClient(request);

    const { data: expense } = await supabase
      .from("job_expenses")
      .select("*, jobs(job_number, title)")
      .eq("id", expenseId)
      .single();

    if (!expense) return NextResponse.json({ error: "Expense not found" }, { status: 404 });
    if (expense.xero_bill_id) return NextResponse.json({ error: "Expense already pushed to Xero" }, { status: 400 });

    const { xero, tenantId, defaultExpenseAccountCode } = await getRefreshedXero();

    if (!defaultExpenseAccountCode) {
      return NextResponse.json(
        { error: "Set a default Xero expense account code in Settings before pushing expenses to Xero" },
        { status: 400 }
      );
    }

    const job = expense.jobs as any;

    const contact: Contact = { name: expense.supplier_name };

    const lineItems: LineItem[] = [
      {
        description: `#${job?.job_number ?? ""} — ${job?.title ?? ""}${expense.description ? `: ${expense.description}` : ""}`,
        quantity: 1,
        unitAmount: Number(expense.amount),
        taxType: "INPUT",
        accountCode: defaultExpenseAccountCode,
      },
    ];

    const xeroBill: Invoice = {
      type: Invoice.TypeEnum.ACCPAY,
      contact,
      lineItems,
      lineAmountTypes: LineAmountTypes.Exclusive,
      date: expense.invoice_date ?? undefined,
      reference: `JOB-${job?.job_number ?? ""}${expense.invoice_number ? ` / INV-${expense.invoice_number}` : ""}`,
      status: Invoice.StatusEnum.AUTHORISED,
    };

    const response = await xero.accountingApi.createInvoices(tenantId, { invoices: [xeroBill] });
    const created = response.body.invoices?.[0];

    await supabase
      .from("job_expenses")
      .update({ xero_bill_id: created?.invoiceID, xero_synced_at: new Date().toISOString() })
      .eq("id", expenseId);

    return NextResponse.json({ success: true, xeroBillId: created?.invoiceID });
  } catch (err: any) {
    console.error("Push expense to Xero error:", err.response?.body ?? err);
    return NextResponse.json({ error: describeXeroError(err) }, { status: 500 });
  }
}
