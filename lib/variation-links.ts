// The office's links from costs to variations (variation_cost_links, 0120 (draft)) —
// plant, expenses and supplier POs that belong to a variation. Time is linked
// by time_entries.variation_id instead.
//
// OFFICE/ADMIN ONLY by RLS: a technician's read returns nothing. No amount is
// stored; a link is costed from its source by lib/job-ledger.ts, so it can't
// drift from the record it names.
//
// Before 0120 (draft) is applied the table is missing (42P01 / PGRST205): that is "no
// links" with `ready: false`, never an error, so nothing breaks.

export type VariationLinkSource = "job_expense" | "vendor_order" | "equipment_usage";

export interface VariationLink {
  id: string;
  variation_id: string;
  source: VariationLinkSource;
  source_id: string;
}

type Client = { from: (table: string) => any };

const MISSING_TABLE = new Set(["42P01", "PGRST205"]);

/** True when the error says 0120 (draft)'s table isn't there yet. */
export function isMissingLinksTable(error: { code?: string | null } | null | undefined): boolean {
  return !!error && MISSING_TABLE.has(error.code ?? "");
}

const CHUNK = 100;

/** The links on these variations. `ready: false` = the table isn't there (before 0120 (draft)). */
export async function loadVariationLinks(
  client: Client,
  variationIds: readonly string[]
): Promise<{ links: VariationLink[]; ready: boolean; error: string | null }> {
  const ids = [...new Set(variationIds)];
  if (ids.length === 0) return { links: [], ready: true, error: null };
  const links: VariationLink[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await client
      .from("variation_cost_links")
      .select("id, variation_id, source, source_id")
      .in("variation_id", ids.slice(i, i + CHUNK));
    if (error) {
      if (isMissingLinksTable(error)) return { links: [], ready: false, error: null };
      return { links: [], ready: true, error: error.message ?? "variation links could not be read" };
    }
    links.push(...((data ?? []) as VariationLink[]));
  }
  return { links, ready: true, error: null };
}

/** Each record's variation, keyed "source:id". */
export function linkIndex(links: readonly VariationLink[]): Map<string, string> {
  return new Map(links.map((l) => [`${l.source}:${l.source_id}`, l.variation_id]));
}

/** The records with the variation the office linked them to (variation_id null when none). */
export function withLinkedVariation<T extends { id?: string | null }>(
  items: readonly T[],
  source: VariationLinkSource,
  index: Map<string, string>
): (T & { variation_id: string | null })[] {
  return items.map((x) => ({ ...x, variation_id: x.id ? index.get(`${source}:${x.id}`) ?? null : null }));
}

/** Words for a link source. */
export const LINK_SOURCE_LABEL: Record<VariationLinkSource, string> = {
  job_expense: "Expense",
  vendor_order: "Supplier PO",
  equipment_usage: "Plant",
};

/** The sentence for a refused link write (0120 (draft)'s guard / unique index), never raw database text. */
export function variationLinkError(error: { code?: string | null; message?: string | null } | null | undefined): string {
  if (!error) return "Couldn't link that cost.";
  if (isMissingLinksTable(error)) return "Linking costs to variations isn't switched on yet (migration 0120).";
  if (error.code === "23505") return "That cost is already linked to a variation.";
  const m = error.message ?? "";
  if (/rejected/i.test(m)) return "That variation was rejected — costs can't go against it.";
  if (/isn't on this variation's job/i.test(m)) return "That cost isn't on this variation's job.";
  if (error.code === "42501") return "Only the office can link costs to a variation.";
  return "Couldn't link that cost.";
}
