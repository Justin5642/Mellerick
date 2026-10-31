import type { Contact } from "xero-node";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getRefreshedXero } from "@/lib/xero";

// The supplier list is copied from Xero (Justin, 31 Oct 2026: "Yes, copy from
// Xero"), so nobody types our supplier accounts in twice. Xero contacts marked
// as suppliers become `suppliers` rows (migration 0087, DRAFT, not applied yet), matched on the Xero
// ContactID on every run.
//
// Xero owns the name, account number, phone and whether it is active. The
// ordering email is the office's: Xero's email is often the accounts address,
// so it is only filled in from Xero while the app's is still empty.

export interface SupplierFromXero {
  xero_contact_id: string;
  name: string;
  account_number: string | null;
  email: string | null;
  phone: string | null;
  is_active: boolean;
}

const blank = (s: string | null | undefined) => {
  const t = s?.trim();
  return t ? t : null;
};

/** The row a Xero contact becomes, or null when it is not a usable supplier. */
export function supplierFromXeroContact(c: Contact): SupplierFromXero | null {
  const name = blank(c.name);
  if (!c.contactID || !name || !c.isSupplier) return null;
  const phone = (c.phones ?? []).find((p) => blank(p.phoneNumber) && String(p.phoneType) === "DEFAULT")
    ?? (c.phones ?? []).find((p) => blank(p.phoneNumber));
  return {
    xero_contact_id: c.contactID,
    name,
    account_number: blank(c.accountNumber),
    email: blank(c.emailAddress),
    phone: phone ? [blank(phone.phoneAreaCode), blank(phone.phoneNumber)].filter(Boolean).join(" ") : null,
    is_active: String(c.contactStatus ?? "ACTIVE") === "ACTIVE",
  };
}

// Xero pages contacts 100 at a time; a page short of that is the last.
const PAGE_SIZE = 100;
// A runaway loop (an API that never returns a short page) stops here: 5,000
// contacts is far beyond any plumbing business's supplier list.
const MAX_PAGES = 50;

/**
 * Copies every Xero supplier into `suppliers`. `admin` is a service-role
 * client — callers authorise first (office/admin, or the cron secret).
 */
export async function syncXeroSuppliers(admin: SupabaseClient): Promise<{ added: number; updated: number; total: number }> {
  const { xero, tenantId } = await getRefreshedXero(admin);

  const fromXero: SupplierFromXero[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await xero.accountingApi.getContacts(tenantId, undefined, "IsSupplier==true", "Name ASC", undefined, page, true, false, undefined, PAGE_SIZE);
    const contacts = res.body.contacts ?? [];
    for (const c of contacts) {
      const row = supplierFromXeroContact(c);
      if (row) fromXero.push(row);
    }
    if (contacts.length < PAGE_SIZE) break;
  }
  if (fromXero.length === 0) return { added: 0, updated: 0, total: 0 };

  const { data: existing, error: readError } = await admin
    .from("suppliers")
    .select("xero_contact_id, email")
    .not("xero_contact_id", "is", null);
  if (readError) throw new Error(`suppliers read failed — ${readError.message}`);
  const emailById = new Map<string, string | null>(
    ((existing ?? []) as { xero_contact_id: string; email: string | null }[]).map((r) => [r.xero_contact_id, r.email])
  );

  const now = new Date().toISOString();
  const rows = fromXero.map((s) => ({
    ...s,
    email: emailById.has(s.xero_contact_id) ? (emailById.get(s.xero_contact_id) ?? s.email) : s.email,
    updated_at: now,
  }));
  const { error: writeError } = await admin.from("suppliers").upsert(rows, { onConflict: "xero_contact_id" });
  if (writeError) throw new Error(`suppliers write failed — ${writeError.message}`);

  const added = rows.filter((r) => !emailById.has(r.xero_contact_id)).length;
  return { added, updated: rows.length - added, total: rows.length };
}
