import { describe, it, expect } from "vitest";
import { replaceLineItems, moneyTotals } from "../../lib/replace-line-items";

// THE DATA-DESTROYING EDIT.
//
// Both document edit pages saved like this (invoices/[id]/edit/page.tsx:94-115,
// and quotes/[id]/edit/page.tsx:93-113 byte-for-byte the same):
//
//   await supabase.from("invoices").update({ … }).eq("id", id);      // unchecked
//   await supabase.from("invoice_items").delete().eq("invoice_id", id); // unchecked
//   await supabase.from("invoice_items").insert(validItems);         // unchecked
//   toast.success("Invoice updated");
//   router.push(`/dashboard/invoices/${id}`);
//
// The delete removes EVERY line of the invoice, then the insert puts them back.
// If the insert is refused — RLS, a constraint, a dropped connection — the lines
// are gone permanently, the user is told it saved, and the page navigates away
// with the only copy (React state) discarded. On a document a customer is
// charged from and may already have received.
//
// Error-checking the three calls in sequence does NOT fix it: there is still a
// window where the delete has committed and the insert has not, and nothing can
// put the rows back. The order has to change.
//
// A real transaction is the correct answer and needs a Postgres function, i.e.
// a migration — handed over here rather than applied (standing rule 6). Absent
// that, insert-first is the strongest available: the new rows land BEFORE
// anything is destroyed, so a failure leaves the original document intact.
// Briefly the document holds both sets; if the cleanup then fails, the rows we
// just added are removed, restoring exactly what we found.

type Row = { id: string };

/**
 * Supabase-shaped fake. `insert().select()` returns ids; `delete()` chains
 * either .eq().not() (retire the old) or .in() (compensate).
 */
function fakeDb(opts: { insert?: { data: Row[] | null; error?: { message: string } }; retire?: { error: { message: string } }; compensate?: { error: { message: string } } } = {}) {
  const calls: string[] = [];
  const client = {
    from() {
      return {
        insert() {
          calls.push("insert");
          return {
            select: async () => opts.insert ?? { data: [{ id: "new-1" }, { id: "new-2" }], error: null },
          };
        },
        delete() {
          return {
            // `.eq(parent)` is a junction, not a terminal: the safe path
            // continues into `.not("id","in",…)`, while `await`ing it directly
            // is the UNSAFE delete-everything that this module exists to
            // prevent.
            //
            // It has to be BOTH chainable and thenable, or the fake absorbs the
            // dangerous call. The first version of this double returned a plain
            // object here, so `await supabase.from(t).delete().eq(...)` resolved
            // to that object, recorded nothing, and every assertion below stayed
            // green with the destructive order restored — the test could not see
            // the one regression it was written for. Caught by negative control,
            // which is the only reason it is right now.
            eq: () => ({
              not: async () => {
                calls.push("retire-old");
                return opts.retire ?? { error: null };
              },
              then: (resolve: (v: unknown) => unknown) => {
                calls.push("delete-all-UNSAFE");
                return Promise.resolve(opts.retire ?? { error: null }).then(resolve);
              },
            }),
            // compensate: .in("id", newIds)
            in: async () => {
              calls.push("compensate");
              return opts.compensate ?? { error: null };
            },
          };
        },
      };
    },
  };
  return { client, calls };
}

const ITEMS = [
  { name: "Labour", description: null, quantity: 1, unit_price: 100 },
  { name: "Parts", description: null, quantity: 2, unit_price: 50 },
];

describe("replaceLineItems", () => {
  it("inserts the replacements BEFORE destroying anything", async () => {
    const { client, calls } = fakeDb();
    await replaceLineItems(client as never, "invoice_items", "invoice_id", "inv-1", ITEMS);
    expect(calls[0]).toBe("insert");
  });

  it("leaves the original lines untouched when the insert fails", async () => {
    // The whole point. Under the old order the lines were already gone by now.
    const { client, calls } = fakeDb({ insert: { data: null, error: { message: "RLS denied" } } });
    const result = await replaceLineItems(client as never, "invoice_items", "invoice_id", "inv-1", ITEMS);

    expect(result.ok).toBe(false);
    expect(calls).toEqual(["insert"]);
  });

  it("retires the previous lines once the replacements are safely in", async () => {
    const { client, calls } = fakeDb();
    const result = await replaceLineItems(client as never, "invoice_items", "invoice_id", "inv-1", ITEMS);

    expect(result.ok).toBe(true);
    expect(calls).toEqual(["insert", "retire-old"]);
  });

  it("removes its own inserts if retiring the old lines fails, rather than leaving both sets", async () => {
    // Doubled lines would double the invoice total on the PDF — visibly wrong,
    // but wrong in a direction that bills the customer twice.
    const { client, calls } = fakeDb({ retire: { error: { message: "retire blew up" } } });
    const result = await replaceLineItems(client as never, "invoice_items", "invoice_id", "inv-1", ITEMS);

    expect(result.ok).toBe(false);
    expect(calls).toEqual(["insert", "retire-old", "compensate"]);
  });

  it("says a human must intervene when even the compensating delete fails", async () => {
    const { client } = fakeDb({
      retire: { error: { message: "retire blew up" } },
      compensate: { error: { message: "compensate blew up" } },
    });
    const result = await replaceLineItems(client as never, "invoice_items", "invoice_id", "inv-1", ITEMS);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.toLowerCase()).toMatch(/duplicat|both sets|by hand/);
  });

  it("treats an empty replacement set as a refusal, not as 'delete everything'", async () => {
    // Under the old code an empty validItems list skipped the insert entirely
    // and left the document with no lines at all — and both send routes then
    // refuse to send it. Better to refuse here, where the data still exists.
    const { client, calls } = fakeDb();
    const result = await replaceLineItems(client as never, "invoice_items", "invoice_id", "inv-1", []);

    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

// 2.1 — the same edit path stored raw float arithmetic. decimal(10,2) bounds the
// error to a cent, so the harm is not a wrong charge but a tax invoice that does
// not add up: invoice_items.total is a Postgres generated column computed in
// exact numeric, while subtotal/tax/total carried the JS artifact, and each
// rounds independently on the PDF.
describe("moneyTotals", () => {
  it("rounds to cents rather than storing the float artifact", () => {
    // 3.35 × 29.90 is 100.165 in exact decimal but 100.16499999999999 in binary.
    const { subtotal } = moneyTotals([{ quantity: 3.35, unit_price: 29.9 }]);
    expect(subtotal).toBe(100.17);
  });

  it("derives the total from the rounded parts, so subtotal + GST === total", () => {
    const { subtotal, tax, total } = moneyTotals([
      { quantity: 3.35, unit_price: 29.9 },
      { quantity: 1, unit_price: 0.05 },
    ]);
    expect(Number((subtotal + tax).toFixed(2))).toBe(total);
  });

  it("computes GST from the rounded subtotal, not the raw one", () => {
    const { subtotal, tax } = moneyTotals([{ quantity: 1, unit_price: 0.05 }]);
    expect(tax).toBe(Number((subtotal * 0.1).toFixed(2)));
  });

  it("treats missing or unparseable numbers as zero rather than NaN", () => {
    // A blank quantity must not poison the whole invoice total.
    const { subtotal, total } = moneyTotals([{ quantity: Number.NaN, unit_price: 10 }]);
    expect(subtotal).toBe(0);
    expect(total).toBe(0);
  });
});
