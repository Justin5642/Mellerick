import type { SupabaseClient } from "@supabase/supabase-js";

// Replacing the line items of an invoice or quote, without a transaction.
//
// Both edit pages did it in the order that loses data:
//
//   await supabase.from("invoice_items").delete().eq("invoice_id", id);  // unchecked
//   await supabase.from("invoice_items").insert(validItems);             // unchecked
//   toast.success("Invoice updated"); router.push(…);
//
// The delete removes EVERY line first. A refused insert therefore destroys the
// lines of a document a customer is charged from — permanently, because the page
// then navigates away and the only other copy was React state — while telling
// the user it saved.
//
// Checking all three results in sequence does not fix it. There is still a
// window where the delete has committed and the insert has not, and nothing can
// put those rows back.
//
// So the order changes: insert the replacements FIRST, then retire the old rows
// by excluding the ids we just created. A failure at the insert leaves the
// original document exactly as it was. A failure at the retire leaves both sets
// briefly, so we remove our own inserts and restore what we found.
//
// THE PROPER FIX is one transaction — a Postgres function called over .rpc(),
// which makes this whole module unnecessary. That needs a migration, and
// migrations are handed over rather than applied from here
// (HANDOVER-HARDENING.md standing rule 6). Draft it and this collapses to one
// call; until then this is the strongest version available in application code.

export type ReplaceResult = { ok: true } | { ok: false; error: string };

export type LineItemInput = {
  name: string;
  description: string | null;
  quantity: number;
  unit_price: number;
};

export async function replaceLineItems(
  supabase: SupabaseClient,
  table: "invoice_items" | "quote_items",
  parentColumn: "invoice_id" | "quote_id",
  parentId: string,
  items: LineItemInput[]
): Promise<ReplaceResult> {
  // An empty set is a refusal, not an instruction to empty the document. The
  // old code skipped the insert when nothing was valid and left the document
  // with no lines at all — which both send routes then refuse to send, after
  // the data is already gone. Refusing here keeps it.
  if (items.length === 0) {
    return { ok: false, error: "A document must keep at least one line item — nothing was saved." };
  }

  // 1. Replacements first. Nothing has been destroyed if this fails.
  const { data: inserted, error: insertError } = await supabase
    .from(table)
    .insert(items.map((i) => ({ ...i, [parentColumn]: parentId })))
    .select("id");

  if (insertError || !inserted?.length) {
    return {
      ok: false,
      error:
        `Could not save the new line items (${insertError?.message ?? "no rows returned"}). ` +
        `Nothing was changed — the existing lines are intact.`,
    };
  }

  const newIds = (inserted as Array<{ id: string }>).map((r) => r.id);

  // 2. Retire everything that is not one of the rows we just created.
  const { error: retireError } = await supabase
    .from(table)
    .delete()
    .eq(parentColumn, parentId)
    .not("id", "in", `(${newIds.join(",")})`);

  if (!retireError) return { ok: true };

  // 3. Both sets are present, which would double the document's totals. Undo
  //    our own inserts and leave the original exactly as we found it.
  const { error: undoError } = await supabase.from(table).delete().in("id", newIds);

  if (undoError) {
    return {
      ok: false,
      error:
        `This document now has DUPLICATED line items and could not be repaired automatically ` +
        `(retire: ${retireError.message}; undo: ${undoError.message}). ` +
        `Its totals will be wrong until the extra lines are removed by hand. Do not re-save.`,
    };
  }

  return {
    ok: false,
    error:
      `Could not replace the line items (${retireError.message}). ` +
      `The change was rolled back and the document is unchanged.`,
  };
}

// ---------------------------------------------------------------------------
// Money totals, rounded once, in one place.
//
// The edit pages computed `subtotal = Σ qty × price` in raw binary floating
// point and stored it. decimal(10,2) bounds the error to a cent, so this never
// produced a materially wrong charge — but invoice_items.total is a Postgres
// GENERATED column computed in exact numeric, while subtotal/tax/total carried
// the JS artifact, and all three round independently when rendered. The result
// is a tax invoice whose subtotal plus GST does not equal its total.
// ---------------------------------------------------------------------------

const cents = (n: number) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);

export function moneyTotals(
  items: Array<{ quantity: number; unit_price: number }>
): { subtotal: number; tax: number; total: number } {
  // Round each line before summing, matching what the generated column stores
  // per row — summing raw and rounding once would disagree with the line totals
  // the customer can add up themselves.
  const subtotal = cents(items.reduce((sum, i) => sum + cents((i.quantity || 0) * (i.unit_price || 0)), 0));
  const tax = cents(subtotal * 0.1);
  return { subtotal, tax, total: cents(subtotal + tax) };
}
