import { escapeHtml } from "@/lib/html";

// Supplier purchase orders raised from the phone (migration 0085 — DRAFT, not
// applied yet). The rules and the email live here, apart from the route, so
// they can be tested without a database.
//
// No price anywhere in this file: technicians raise these, and technicians
// never see a dollar figure (HANDOVER §2). The office adds the cost when the
// supplier's invoice arrives.

export interface SupplierOrderItemInput {
  description: string;
  quantity: number;
}

export interface SupplierOrderInput {
  id: string;
  costCenterId: string | null;
  supplierName: string;
  supplierEmail: string | null;
  deliveryAddress: string | null;
  requiredBy: string | null;
  notes: string | null;
  items: SupplierOrderItemInput[];
}

export const MAX_ITEMS = 50;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

/** Validates the request body. Returns the order, or a sentence fit to show the tech. */
export function parseSupplierOrder(body: unknown): { ok: true; order: SupplierOrderInput } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;

  // Generated on the phone, so a retried request after a dropped connection
  // is recognised instead of raising (and emailing) the same order twice.
  if (typeof b.id !== "string" || !UUID.test(b.id)) return { ok: false, error: "Order id is missing — update the app." };

  const supplierName = text(b.supplierName, 120);
  if (!supplierName) return { ok: false, error: "Enter the supplier's name." };

  const supplierEmail = text(b.supplierEmail, 200);
  if (supplierEmail && !EMAIL.test(supplierEmail)) return { ok: false, error: "That supplier email address doesn't look right." };

  const costCenterId = b.costCenterId == null || b.costCenterId === "" ? null : b.costCenterId;
  if (costCenterId !== null && (typeof costCenterId !== "string" || !UUID.test(costCenterId))) {
    return { ok: false, error: "Pick the cost centre again." };
  }

  const requiredBy = text(b.requiredBy, 10);
  if (requiredBy && !DATE.test(requiredBy)) return { ok: false, error: "Required-by date is invalid." };

  if (!Array.isArray(b.items)) return { ok: false, error: "Add at least one item." };
  const items: SupplierOrderItemInput[] = [];
  for (const raw of b.items) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const description = text(r.description, 300);
    if (!description) continue; // a blank row left on the form
    const quantity = typeof r.quantity === "number" ? r.quantity : Number(r.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 99999) {
      return { ok: false, error: `Check the quantity for "${description}".` };
    }
    items.push({ description, quantity: Math.round(quantity * 100) / 100 });
  }
  if (items.length === 0) return { ok: false, error: "Add at least one item." };
  if (items.length > MAX_ITEMS) return { ok: false, error: `A PO can have at most ${MAX_ITEMS} items.` };

  return {
    ok: true,
    order: {
      id: b.id,
      costCenterId,
      supplierName,
      supplierEmail,
      deliveryAddress: text(b.deliveryAddress, 300),
      requiredBy,
      notes: text(b.notes, 1000),
      items,
    },
  };
}

function qty(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function displayDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

export interface SupplierOrderEmail {
  poNumber: string;
  jobNumber: number | null;
  supplierName: string;
  raisedBy: { name: string; phone: string | null } | null;
  deliveryAddress: string | null;
  requiredBy: string | null;
  notes: string | null;
  items: SupplierOrderItemInput[];
  business: { name: string; phone: string; email: string; address: string; abn: string };
}

/** Subject + HTML for the PO sent to the supplier. Every typed value is escaped. */
export function supplierOrderEmail(o: SupplierOrderEmail): { subject: string; html: string } {
  const ref = o.jobNumber != null ? ` — Job ${o.jobNumber}` : "";
  const rows = o.items
    .map(
      (i) =>
        `<tr><td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;">${escapeHtml(i.description)}</td>` +
        `<td style="padding:6px 8px;border-bottom:1px solid #e2e8f0;text-align:right;">${qty(i.quantity)}</td></tr>`
    )
    .join("");
  const detail = (label: string, value: string | null) =>
    value ? `<p style="margin:4px 0;"><strong>${label}:</strong> ${value}</p>` : "";
  const contact = o.raisedBy
    ? escapeHtml(o.raisedBy.name) + (o.raisedBy.phone ? ` (${escapeHtml(o.raisedBy.phone)})` : "")
    : null;

  return {
    subject: `Purchase Order ${o.poNumber} from ${o.business.name}${ref}`,
    html: `
      <div style="font-family: sans-serif; color: #1e293b; line-height: 1.5;">
        <p>Hi ${escapeHtml(o.supplierName)},</p>
        <p>Please supply the following against <strong>Purchase Order ${escapeHtml(o.poNumber)}</strong>${o.jobNumber != null ? ` for our job <strong>${o.jobNumber}</strong>` : ""}.</p>
        <p><strong>Please quote ${escapeHtml(o.poNumber)} on your delivery docket and invoice.</strong></p>
        <table style="border-collapse:collapse;width:100%;max-width:560px;margin:12px 0;">
          <thead><tr>
            <th style="text-align:left;padding:6px 8px;background:#f1f5f9;">Item</th>
            <th style="text-align:right;padding:6px 8px;background:#f1f5f9;">Qty</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        ${detail("Deliver to", o.deliveryAddress ? escapeHtml(o.deliveryAddress) : null)}
        ${detail("Required by", o.requiredBy ? displayDate(o.requiredBy) : null)}
        ${detail("Ordered by", contact)}
        ${o.notes ? `<p style="margin:12px 0 4px;"><strong>Notes:</strong><br/>${escapeHtml(o.notes).replace(/\n/g, "<br/>")}</p>` : ""}
        <p style="margin-top:16px;">Invoices to ${escapeHtml(o.business.email)}. Questions: reply to this email or call ${escapeHtml(o.business.phone)}.</p>
        <p>Thanks,<br/>${escapeHtml(o.business.name)}<br/>
          <span style="color:#64748b;font-size:12px;">${escapeHtml(o.business.address)} · ABN ${escapeHtml(o.business.abn)}</span></p>
      </div>
    `,
  };
}
