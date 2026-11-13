// The supplier picker on every purchase order form (web PO tab, phone Orders
// tab). Justin, Nov 2026: picking a supplier should be faster than scrolling
// the whole Xero contact list, so the list is grouped:
//
//   Pinned     the main suppliers (Reece, Plumbers Co-op, Northern Quarries,
//              Boral), set in Settings → Suppliers (suppliers.pin_order,
//              from 0097 — drafted, not applied yet)
//   Recent     the last suppliers used on POs, most recent first, pinned ones
//              skipped so nothing shows twice
//   All        everyone else, A–Z
//
// Search filters every group as you type. Pure — no I/O. Mirrored
// byte-identical (comments aside) at mobile/lib/supplierPicker.ts and pinned
// by tests/unit/supplier-picker.test.ts.

export interface PickerSupplier {
  id?: string;
  name: string;
  /** Position in the Pinned group, 1 first. Null/absent = not pinned. */
  pinOrder?: number | null;
}

/** One past PO, for working out "recent". */
export interface SupplierUse {
  supplierId: string | null;
  vendorName: string | null;
  enteredBy: string | null;
  createdAt: string | null;
}

export type SupplierGroupKey = "pinned" | "recent" | "all";

export interface SupplierGroup<T extends PickerSupplier> {
  key: SupplierGroupKey;
  label: string;
  suppliers: T[];
}

export const RECENT_SUPPLIER_LIMIT = 8;
// How many distinct recent suppliers the server hands over: enough to still
// fill the Recent group after the pinned ones are taken out.
export const RECENT_SUPPLIER_CANDIDATES = 20;

const GROUP_LABELS: Record<SupplierGroupKey, string> = {
  pinned: "Pinned",
  recent: "Recent",
  all: "All suppliers",
};

function normalise(s: string): string {
  return s.trim().toLowerCase();
}

function compact(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function byName(a: PickerSupplier, b: PickerSupplier): number {
  return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
}

export function isPinned(s: PickerSupplier): boolean {
  return typeof s.pinOrder === "number" && Number.isFinite(s.pinOrder);
}

/**
 * How well a supplier's name matches what was typed. 0 = no match.
 * 3 the name starts with it, 2 a word in it does ("epp" → "Reece Epping"),
 * 1 it is in there somewhere, ignoring spaces and punctuation ("coop" →
 * "Plumbers Co-op").
 */
export function supplierMatchRank(name: string, query: string): number {
  const q = normalise(query);
  if (!q) return 3;
  const n = name.toLowerCase();
  if (n.startsWith(q)) return 3;
  if (n.split(/[^a-z0-9]+/).some((w) => w.startsWith(q))) return 2;
  const cq = compact(q);
  if (n.includes(q) || (cq !== "" && compact(n).includes(cq))) return 1;
  return 0;
}

/**
 * The suppliers used on POs, most recent first, as ids from `suppliers`.
 *
 * The caller's own POs come first, then the rest of the company's: a
 * technician mostly reorders from the suppliers they use, and someone new (or
 * the office, whose older web POs carry no entered_by) still gets a useful
 * list from day one. An order typed in as "Other supplier", or raised before
 * orders were linked to the list, counts when its name matches a supplier's
 * name exactly (ignoring case). Suppliers not in `suppliers` (inactive,
 * removed) are skipped.
 */
export function recentSupplierIds(
  uses: SupplierUse[],
  suppliers: PickerSupplier[],
  userId: string | null,
  limit = RECENT_SUPPLIER_CANDIDATES
): string[] {
  const ids = new Set<string>();
  const idByName = new Map<string, string>();
  for (const s of suppliers) {
    if (!s.id) continue;
    ids.add(s.id);
    const key = normalise(s.name);
    if (!idByName.has(key)) idByName.set(key, s.id);
  }
  const resolve = (u: SupplierUse): string | null => {
    if (u.supplierId && ids.has(u.supplierId)) return u.supplierId;
    if (u.supplierId) return null; // linked to a supplier no longer on the list
    return u.vendorName ? idByName.get(normalise(u.vendorName)) ?? null : null;
  };
  const time = (u: SupplierUse) => {
    const t = u.createdAt ? Date.parse(u.createdAt) : NaN;
    return Number.isFinite(t) ? t : -Infinity;
  };
  const sorted = uses
    .map((u, i) => ({ u, i }))
    .sort((a, b) => time(b.u) - time(a.u) || a.i - b.i)
    .map((x) => x.u);

  const out: string[] = [];
  const seen = new Set<string>();
  const take = (mine: boolean) => {
    for (const u of sorted) {
      if (out.length >= limit) return;
      if (mine && (!userId || u.enteredBy !== userId)) continue;
      const id = resolve(u);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  };
  take(true);
  take(false);
  return out;
}

/**
 * The picker's groups, in order, empty ones left out.
 *
 * No search: Pinned (by pin order), Recent (up to `recentLimit`, pinned ones
 * skipped), then every other supplier A–Z. A search keeps the same groups but
 * filters each one; the All group then lists the best matches first (name
 * starts with it, then a word does, then anywhere), A–Z within each.
 */
export function groupSuppliers<T extends PickerSupplier>(
  suppliers: T[],
  opts: { recentIds?: string[] | null; query?: string; recentLimit?: number } = {}
): SupplierGroup<T>[] {
  const query = opts.query ?? "";
  const recentLimit = opts.recentLimit ?? RECENT_SUPPLIER_LIMIT;

  const pinned = suppliers
    .filter(isPinned)
    .sort((a, b) => (a.pinOrder as number) - (b.pinOrder as number) || byName(a, b));
  const pinnedSet = new Set<T>(pinned);

  const byId = new Map<string, T>();
  for (const s of suppliers) if (s.id && !byId.has(s.id)) byId.set(s.id, s);
  const recent: T[] = [];
  for (const id of opts.recentIds ?? []) {
    if (recent.length >= recentLimit) break;
    const s = byId.get(id);
    if (!s || pinnedSet.has(s) || recent.includes(s)) continue;
    recent.push(s);
  }
  const shown = new Set<T>([...pinned, ...recent]);
  const rest = suppliers.filter((s) => !shown.has(s)).sort(byName);

  const matches = (list: T[]) => list.filter((s) => supplierMatchRank(s.name, query) > 0);
  const restMatches = normalise(query)
    ? matches(rest).sort((a, b) => supplierMatchRank(b.name, query) - supplierMatchRank(a.name, query) || byName(a, b))
    : rest;

  const groups: SupplierGroup<T>[] = [
    { key: "pinned", label: GROUP_LABELS.pinned, suppliers: matches(pinned) },
    { key: "recent", label: GROUP_LABELS.recent, suppliers: matches(recent) },
    { key: "all", label: GROUP_LABELS.all, suppliers: restMatches },
  ];
  return groups.filter((g) => g.suppliers.length > 0);
}
