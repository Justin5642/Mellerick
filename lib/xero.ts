import { XeroClient, Invoice } from "xero-node";

export function getXeroClient() {
  return new XeroClient({
    clientId: process.env.XERO_CLIENT_ID!,
    clientSecret: process.env.XERO_CLIENT_SECRET!,
    redirectUris: [process.env.XERO_REDIRECT_URI!],
    scopes: ["openid", "profile", "email", "accounting.contacts", "accounting.invoices", "offline_access"],
    httpTimeout: 30000,
  });
}

/**
 * Returns an authenticated Xero client for the single connected org,
 * refreshing (and persisting) the access token if it's expired. Throws if
 * Xero isn't connected -- callers that need to distinguish "not connected"
 * from a real error should check `xero_tokens` themselves first.
 *
 * Accepts an optional Supabase client so callers without a browser session
 * (e.g. a cron job using the service-role client) can reuse the same logic.
 * Same shared-refresh-logic shape as lib/google.ts's getGoogleCalendarClient,
 * previously duplicated three times (push-invoice, push-expense, and now
 * poll-invoices would have made a fourth) -- consolidated here instead.
 */
export async function getRefreshedXero(supabaseClient?: any) {
  const supabase = supabaseClient ?? (await (await import("@/lib/supabase/server")).createClient());
  const { data: tokenRow } = await supabase.from("xero_tokens").select("*").single();
  if (!tokenRow) throw new Error("Xero not connected");

  const xero = getXeroClient();
  xero.setTokenSet({
    access_token: tokenRow.access_token,
    refresh_token: tokenRow.refresh_token,
    expires_in: Math.floor((new Date(tokenRow.token_expiry).getTime() - Date.now()) / 1000),
  });

  if (new Date(tokenRow.token_expiry) < new Date()) {
    // xero-node's refreshToken() reaches into this.openIdClient directly
    // without lazily creating it (unlike buildConsentUrl, which does) --
    // skipping initialize() throws "Cannot read properties of undefined
    // (reading 'refresh')" the moment a token has actually expired. Confirmed
    // by reproducing it directly against the live Xero connection.
    await xero.initialize();
    const newTokenSet = await xero.refreshToken();
    await supabase
      .from("xero_tokens")
      .update({
        access_token: newTokenSet.access_token!,
        refresh_token: newTokenSet.refresh_token!,
        token_expiry: new Date(Date.now() + (newTokenSet.expires_in as number) * 1000).toISOString(),
      })
      .eq("id", tokenRow.id);
  }

  return {
    xero,
    tenantId: tokenRow.tenant_id as string,
    defaultExpenseAccountCode: tokenRow.default_expense_account_code as string | null,
  };
}

/**
 * Pulls payment status back from Xero for every locally-tracked invoice
 * that's been pushed (has a xero_invoice_id) and isn't already resolved
 * (still 'sent' or 'overdue') -- the reverse half of the one-way push in
 * /api/xero/push-invoice. Without this, an invoice paid directly in Xero
 * (bank feed reconciliation, manual entry, etc) never reflects as paid here,
 * so Reports' "Total Outstanding"/"Total Overdue" figures silently go stale.
 *
 * Also flips 'sent' -> 'overdue' locally once due_date has passed and the
 * invoice still isn't paid -- nothing else in the app currently sets that
 * status, so Reports' overdue bucket has effectively never been populated
 * until now.
 *
 * Shared by the cron-driven poll route and the Settings page's manual
 * "Sync now" button, same pattern as pollGoogleCalendarChanges.
 */
export async function pollXeroInvoicePayments(supabase: any) {
  const { data: tokenRow } = await supabase.from("xero_tokens").select("*").single();
  if (!tokenRow) return { skipped: true, reason: "Xero not connected" };

  const { data: candidates } = await supabase
    .from("invoices")
    .select("id, xero_invoice_id, status, due_date, total")
    .in("status", ["sent", "overdue"])
    .not("xero_invoice_id", "is", null);

  if (!candidates || candidates.length === 0) {
    await supabase.from("xero_tokens").update({ xero_invoice_last_synced_at: new Date().toISOString() }).eq("id", tokenRow.id);
    return { markedPaid: 0, markedOverdue: 0, checked: 0 };
  }

  const { xero, tenantId } = await getRefreshedXero(supabase);

  const byXeroId = new Map<string, any>(candidates.map((inv: any) => [inv.xero_invoice_id as string, inv]));
  const allIds = Array.from(byXeroId.keys());

  let markedPaid = 0;
  let markedOverdue = 0;
  const today = new Date().toISOString().slice(0, 10);

  // Xero's getInvoices accepts a batch of IDs per call -- chunk to stay well
  // under any practical URL/query-size limit rather than one call per invoice.
  const CHUNK_SIZE = 100;
  for (let i = 0; i < allIds.length; i += CHUNK_SIZE) {
    const chunk = allIds.slice(i, i + CHUNK_SIZE);
    const response = await xero.accountingApi.getInvoices(
      tenantId,
      undefined, undefined, undefined,
      chunk as any
    );
    const xeroInvoices = response.body.invoices ?? [];

    for (const xInv of xeroInvoices) {
      const local = byXeroId.get(xInv.invoiceID as string);
      if (!local) continue;

      const fullyPaid = xInv.status === Invoice.StatusEnum.PAID || (xInv.amountDue !== undefined && Number(xInv.amountDue) <= 0);

      if (fullyPaid) {
        await supabase
          .from("invoices")
          .update({
            status: "paid",
            amount_paid: Number(xInv.amountPaid ?? local.total),
            paid_at: xInv.fullyPaidOnDate ?? new Date().toISOString(),
          })
          .eq("id", local.id);
        markedPaid++;
        continue;
      }

      // Still unpaid in Xero -- keep local status current with due_date.
      const isOverdue = local.due_date && local.due_date < today;
      if (isOverdue && local.status !== "overdue") {
        await supabase.from("invoices").update({ status: "overdue" }).eq("id", local.id);
        markedOverdue++;
      } else if (!isOverdue && local.status === "overdue") {
        // Due date was pushed out / corrected in Xero -- move back to "sent".
        await supabase.from("invoices").update({ status: "sent" }).eq("id", local.id);
      }
    }
  }

  await supabase.from("xero_tokens").update({ xero_invoice_last_synced_at: new Date().toISOString() }).eq("id", tokenRow.id);

  return { markedPaid, markedOverdue, checked: allIds.length };
}
