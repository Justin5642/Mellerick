import { NextRequest, NextResponse } from "next/server";
import { getXeroClient } from "@/lib/xero";
import { createClient } from "@/lib/supabase/server";
import { Invoice, LineItem, Contact, LineAmountTypes } from "xero-node";

// Manual, per-expense "push to Xero" action — same pattern/UX as the
// existing /api/xero/push-invoice (manual button, never automatic). Creates
// a Xero Bill (ACCPAY) for the supplier, coded to the office-configured
// default_expense_account_code, with the job number in the Reference field
// so the cost is identifiable per job in Xero reporting.
async function getRefreshedXero() {
  const supabase = await createClient();
  const { data: tokenRow } = await supabase.from("xero_tokens").select("*").single();
  if (!tokenRow) throw new Error("Xero not connected");

  const xero = getXeroClient();
  xero.setTokenSet({
    access_token: tokenRow.access_token,
    refresh_token: tokenRow.refresh_token,
    expires_in: Math.floor((new Date(tokenRow.token_expiry).getTime() - Date.now()) / 1000),
  });

  if (new Date(tokenRow.token_expiry) < new Date()) {
    const newTokenSet = await xero.refreshToken();
    await supabase.from("xero_tokens").update({
      access_token: newTokenSet.access_token!,
      refresh_token: newTokenSet.refresh_token!,
      token_expiry: new Date(Date.now() + (newTokenSet.expires_in as number) * 1000).toISOString(),
    }).eq("id", tokenRow.id);
  }

  return { xero, tenantId: tokenRow.tenant_id, defaultExpenseAccountCode: tokenRow.default_expense_account_code as string | null };
}

export async function POST(request: NextRequest) {
  try {
    const { expenseId } = await request.json();
    const supabase = await createClient();

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
    console.error("Push expense to Xero error:", err);
    return NextResponse.json({ error: err.message ?? "Failed to push expense to Xero" }, { status: 500 });
  }
}
