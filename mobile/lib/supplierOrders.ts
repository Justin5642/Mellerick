import { supabase } from "./supabase";
import { fetchWithTimeout } from "./fetchWithTimeout";

// Supplier purchase orders, raised from a job (web: /api/jobs/[id]/supplier-orders,
// migration 0085). Online only, on purpose: the order is emailed to the
// supplier the moment it is raised, and the tech needs the PO number back
// before they leave the counter. Not through the outbox — a PO that sat
// queued for hours without signal would reach the supplier too late to be
// useful, and silently.
//
// The route never returns a price. Nothing here has one.

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;

export interface SupplierOrder {
  id: string;
  poNumber: string;
  supplierName: string;
  supplierEmail: string | null;
  status: "ordered" | "received" | "cancelled";
  costCenterId: string | null;
  deliveryAddress: string | null;
  requiredBy: string | null;
  notes: string | null;
  createdAt: string;
  emailedAt: string | null;
  raisedBy: string | null;
  items: { description: string; quantity: number }[];
}

export interface SupplierOrdersState {
  orders: SupplierOrder[];
  defaultCostCenterId: string | null;
  clockedIn: boolean;
  deliveryAddress: string | null;
  suppliers: { name: string; email: string }[];
}

export interface NewSupplierOrder {
  id: string;
  costCenterId: string | null; // required — null only while the form is being filled
  supplierName: string;
  supplierEmail: string | null;
  deliveryAddress: string | null;
  requiredBy: string | null;
  notes: string | null;
  items: { description: string; quantity: number }[];
}

export interface RaisedSupplierOrder {
  poNumber: string;
  emailed: boolean;
  emailedTo: string | null;
  warning?: string;
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!API_BASE_URL) throw new Error("App isn't configured to reach the office server.");
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("Your session has expired. Sign out and back in, then try again.");
  let res: Response;
  try {
    res = await fetchWithTimeout(`${API_BASE_URL}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new Error("No connection. Purchase orders need signal — try again when you have it.");
  }
  // A non-JSON body (a platform error page) must still surface the status.
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Server returned ${res.status}. Try again.`);
  return data as T;
}

export function loadSupplierOrders(jobId: string): Promise<SupplierOrdersState> {
  return call(`/api/jobs/${jobId}/supplier-orders`);
}

/**
 * Safe to retry with the same `order.id`: the server recognises it and hands
 * back the PO it already raised, without emailing the supplier twice.
 */
export function raiseSupplierOrder(jobId: string, order: NewSupplierOrder): Promise<RaisedSupplierOrder> {
  return call(`/api/jobs/${jobId}/supplier-orders`, { method: "POST", body: JSON.stringify(order) });
}

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** The form's own check before sending — the same rules the server applies. Null = fine. */
export function supplierOrderProblem(
  o: Pick<NewSupplierOrder, "costCenterId" | "supplierName" | "supplierEmail" | "items">
): string | null {
  // No PO without a cost centre (Justin, 28 Oct 2026).
  if (!o.costCenterId) return "Pick the cost centre this PO is for.";
  if (!o.supplierName.trim()) return "Enter the supplier's name.";
  if (o.supplierEmail && !EMAIL.test(o.supplierEmail.trim())) return "That supplier email address doesn't look right.";
  const filled = o.items.filter((i) => i.description.trim());
  if (filled.length === 0) return "Add at least one item.";
  const bad = filled.find((i) => !Number.isFinite(i.quantity) || i.quantity <= 0);
  if (bad) return `Check the quantity for "${bad.description.trim()}".`;
  return null;
}
