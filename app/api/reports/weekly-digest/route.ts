import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireCronSecret } from "@/lib/api/guards";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import { getFromAddress, getResend } from "@/lib/resend";
import { appUrl } from "@/lib/env";
import { coverageByMonth, loadBills, unallocatedSummary } from "@/lib/unallocated-bills";
import { buildDigest, type DigestDebtor } from "@/lib/weekly-digest";
import { reportError } from "@/lib/monitoring";

export const maxDuration = 60;

// Monday-morning email to the office: bills with no job, how much spend is
// traced to a job, overdue debtors, supplier POs still waiting for an invoice.
// The email is the nudge; the worklist is in the app (Reports → Unallocated
// bills). Recipients come from WEEKLY_DIGEST_TO (comma-separated) — addresses
// are deployment settings, not source code, and this repo is public.

export async function GET(request: NextRequest) {
  const guard = requireCronSecret(request);
  if (!guard.ok) return guard.response;

  const to = (process.env.WEEKLY_DIGEST_TO ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (to.length === 0) {
    return NextResponse.json({ skipped: true, reason: "WEEKLY_DIGEST_TO is not set" });
  }

  try {
    const admin = createAdminClient();

    const loaded = await loadBills(admin, 12);
    if (!loaded.ok) {
      if (loaded.tablesMissing) return NextResponse.json({ skipped: true, reason: "Xero tables not applied yet (migrations 0098/0099)" });
      throw new Error(loaded.error);
    }

    const overdueRows = await fetchAllRows<{ invoice_number: number; due_date: string | null; total: number | null; amount_paid: number | null; customers: { name: string } | null }>(
      (count) =>
        admin
          .from("invoices")
          .select("invoice_number, due_date, total, amount_paid, customers(name)", count)
          .eq("status", "overdue")
          .order("due_date") as never
    );
    if (!overdueRows.ok) throw new Error(overdueRows.error);
    const debtors: DigestDebtor[] = overdueRows.rows
      .map((r) => ({
        customer: r.customers?.name ?? "Unknown customer",
        invoiceNumber: r.invoice_number,
        dueDate: r.due_date,
        balance: Number(r.total ?? 0) - Number(r.amount_paid ?? 0),
      }))
      .filter((d) => d.balance > 0);

    const { data: waiting, count: waitingCount, error: waitingError } = await admin
      .from("vendor_orders")
      .select("po_number, vendor_name, order_date, created_at", { count: "exact" })
      .is("invoice_number", null)
      .neq("status", "cancelled")
      .order("created_at", { ascending: true })
      .limit(8);
    if (waitingError) throw new Error(waitingError.message);

    const digest = buildDigest({
      appUrl: appUrl(),
      unallocated: unallocatedSummary(loaded.bills),
      coverage: coverageByMonth(loaded.bills),
      overdue: {
        count: debtors.length,
        total: debtors.reduce((s, d) => s + d.balance, 0),
        top: [...debtors].sort((a, b) => b.balance - a.balance).slice(0, 8),
      },
      awaitingInvoice: {
        count: waitingCount ?? 0,
        oldest: (waiting ?? []).map((w) => ({
          poNumber: w.po_number ?? "PO",
          supplier: w.vendor_name,
          orderedOn: w.order_date ?? (w.created_at ? String(w.created_at).slice(0, 10) : null),
        })),
      },
    });

    const { error: sendError } = await getResend().emails.send({ from: getFromAddress(), to, subject: digest.subject, html: digest.html, text: digest.text });
    if (sendError) throw new Error(sendError.message);
    return NextResponse.json({ sent: true, recipients: to.length });
  } catch (err) {
    console.error("weekly digest failed:", err);
    reportError(err, { route: "api/reports/weekly-digest", integration: "resend", cron: true });
    return NextResponse.json({ error: "Weekly digest failed" }, { status: 500 });
  }
}
