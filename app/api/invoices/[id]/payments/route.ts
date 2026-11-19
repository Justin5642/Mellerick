import { NextRequest, NextResponse } from "next/server";
import { requireOfficeOrAdmin } from "@/lib/api/guards";
import { callerClient } from "@/lib/api/caller-client";
import { balanceOf, parsePayment, PAYMENT_IN_XERO } from "@/lib/invoice-payments";

// Payments received against an invoice (migration 0081) — the web Payments
// card and the phone both write through here (they used to be a browser
// insert). Office/admin only, and every query runs as the CALLER, so RLS and
// 0081's triggers decide exactly as before: an invoice in Xero refuses a
// manual payment; amount_paid / status / paid_at follow the payments.

const MISSING_TABLE = new Set(["42P01", "PGRST205"]);

/** The invoice's balance, its payments (null on a database without 0081) and whether Xero is connected. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;
  const supabase = await callerClient(request);

  const [invoiceRes, paymentsRes, xeroRes] = await Promise.all([
    supabase.from("invoices").select("id, status, total, amount_paid, xero_invoice_id").eq("id", id).maybeSingle(),
    supabase.from("invoice_payments").select("id, amount, paid_on, method, reference").eq("invoice_id", id).order("paid_on"),
    supabase.from("xero_tokens").select("tenant_name").limit(1).maybeSingle(),
  ]);
  if (invoiceRes.error) {
    console.error("invoice payments: invoice read failed", invoiceRes.error);
    return NextResponse.json({ error: "The invoice could not be loaded. Try again." }, { status: 500 });
  }
  if (!invoiceRes.data) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  if (paymentsRes.error && !MISSING_TABLE.has(paymentsRes.error.code ?? "")) {
    console.error("invoice payments: payments read failed", paymentsRes.error);
    return NextResponse.json({ error: "The payments could not be loaded. Try again." }, { status: 500 });
  }
  if (xeroRes.error) console.error("invoice payments: xero connection read failed", xeroRes.error);

  const inv = invoiceRes.data;
  return NextResponse.json({
    invoice: { ...inv, balance: balanceOf(inv) },
    payments: paymentsRes.error ? null : (paymentsRes.data ?? []).map((p) => ({ ...p, amount: Number(p.amount) })),
    xeroConnected: !xeroRes.error && !!xeroRes.data,
  });
}

/** Record a payment. Answers with the invoice's new balance and status. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const guard = await requireOfficeOrAdmin(request);
  if (!guard.ok) return guard.response;

  const parsed = parsePayment(await request.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const supabase = await callerClient(request);

  const { data: before } = await supabase.from("invoices").select("id, total, amount_paid, xero_invoice_id").eq("id", id).maybeSingle();
  if (!before) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  if (before.xero_invoice_id) return NextResponse.json({ error: PAYMENT_IN_XERO }, { status: 400 });

  const { error } = await supabase.from("invoice_payments").insert({ invoice_id: id, ...parsed.payment });
  if (error) {
    console.error("invoice payments: insert failed", error);
    if (error.code === "22023") return NextResponse.json({ error: PAYMENT_IN_XERO }, { status: 400 });
    if (MISSING_TABLE.has(error.code ?? "")) {
      return NextResponse.json({ error: "Recording payments isn't switched on for this database yet." }, { status: 400 });
    }
    return NextResponse.json({ error: "The payment could not be saved. Please try again." }, { status: 500 });
  }

  const { data: after } = await supabase.from("invoices").select("status, total, amount_paid").eq("id", id).maybeSingle();
  return NextResponse.json({
    ok: true,
    balanceBefore: balanceOf(before),
    status: after?.status ?? null,
    balance: after ? balanceOf(after) : null,
  });
}
