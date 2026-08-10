import type { SupabaseClient } from "@supabase/supabase-js";

// Storing an OAuth token set is a REPLACE of a single row, and both callbacks
// were doing it in the order that loses data:
//
//   await supabase.from("xero_tokens").delete().neq("id", "0000…");   // unchecked
//   await supabase.from("xero_tokens").insert({ … });                 // unchecked
//   return redirect("/dashboard/settings?xero=connected");            // always
//
// The DELETE destroys the working connection first. If the INSERT then fails —
// RLS, a constraint, a dropped connection — the business has no tokens at all
// and is told it is connected. Nothing surfaces until invoices quietly stop
// syncing to Xero, or the calendar stops updating.
//
// Ordering is what fixes it, not just checking the results. Insert first: a
// failure there leaves the previous tokens untouched and still working, and the
// caller can report an honest error.
//
// The row count has to land on exactly one either way, because both tables are
// read with `.single()` (lib/xero.ts:78, lib/google.ts:40) and that errors on
// 2 rows exactly as it does on 0. So if the cleanup delete fails, this removes
// the row it just inserted and puts the table back exactly as it was found.
//
// THE PROPER FIX is one transaction — a security-definer RPC doing delete and
// insert atomically. That needs a migration, and migrations are handed over
// rather than applied from here (HANDOVER-HARDENING.md, standing rule 6), so
// this is the strongest version available in application code. If you are
// writing that migration, this whole module collapses into one `.rpc()` call.

/** A row id is all this needs back from the insert. */
const IMPOSSIBLE_ID = "00000000-0000-0000-0000-000000000000";

export type ReplaceResult = { ok: true } | { ok: false; error: string };

export async function replaceSingletonToken(
  supabase: SupabaseClient,
  table: "xero_tokens" | "google_tokens",
  row: Record<string, unknown>
): Promise<ReplaceResult> {
  // 1. New row first. If this fails, nothing has been destroyed.
  const { data: inserted, error: insertError } = await supabase
    .from(table)
    .insert(row)
    .select()
    .single();

  if (insertError || !inserted) {
    return {
      ok: false,
      error: `Could not store the new ${table} row: ${insertError?.message ?? "no row returned"}. ` +
        `The previous connection is untouched.`,
    };
  }

  const newId = (inserted as { id?: string }).id ?? IMPOSSIBLE_ID;

  // 2. Retire every other row. `.neq` on the id we just created, so this is
  //    "delete the old ones" rather than "delete everything and hope".
  const { error: deleteError } = await supabase.from(table).delete().neq("id", newId);

  if (!deleteError) return { ok: true };

  // 3. Cleanup failed, so the table now holds the new row AND the old ones.
  //    Every reader uses .single(), so that is broken — undo our own insert and
  //    leave the previous state intact.
  const { error: undoError } = await supabase.from(table).delete().eq("id", newId);

  if (undoError) {
    return {
      ok: false,
      error:
        `${table} now holds more than one row and could not be repaired ` +
        `(cleanup: ${deleteError.message}; undo: ${undoError.message}). ` +
        `Every reader uses .single() and will fail until exactly one row remains — ` +
        `delete the extra rows by hand.`,
    };
  }

  return {
    ok: false,
    error: `Could not retire the previous ${table} row: ${deleteError.message}. ` +
      `The new token was rolled back and the previous connection is unchanged.`,
  };
}
