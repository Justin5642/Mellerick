import { describe, it, expect } from "vitest";
import { replaceSingletonToken } from "../../lib/oauth-token-store";

// Both OAuth callbacks stored their tokens like this:
//
//   await supabase.from("xero_tokens").delete().neq("id", "0000…");
//   await supabase.from("xero_tokens").insert({ … });
//   return redirect("/dashboard/settings?xero=connected");
//
// Neither result is checked, and the redirect claims success unconditionally.
// The order is the dangerous part: the DELETE destroys the working connection
// FIRST. If the insert then fails — RLS, a constraint, a dropped connection —
// the business is left with no Xero tokens at all, and is told it is connected.
// The integration is dead until someone notices invoices have stopped syncing.
//
// It cannot be fixed by swapping the checks alone, because both tables are read
// with `.single()` (lib/xero.ts:78, lib/google.ts:40), which errors on 0 rows
// AND on 2+. So the row count has to land on exactly one, or every reader
// breaks.
//
// Hence insert-first: a failure there leaves the old tokens untouched and
// working. The narrow remaining window — new row in, old rows not cleaned up —
// is closed by removing the row we just added, which puts the table back to
// exactly the state we found it in.
//
// The genuinely correct fix is one statement inside a transaction, i.e. a
// security-definer RPC. That needs a migration, and migrations are handed over
// rather than applied here (HANDOVER-HARDENING.md standing rule 6), so this is
// the strongest version available in application code.

type Result = { data?: unknown; error?: { message: string } | null };

/** Minimal PostgREST double: .insert().select().single(), .delete().neq(). */
function fakeDb(opts: {
  insert?: Result;
  delete?: Result;
  cleanup?: Result;
}) {
  const calls: string[] = [];
  let deleteCount = 0;
  const client = {
    from() {
      return {
        insert(row: unknown) {
          calls.push("insert");
          return {
            select() {
              return {
                single: async () =>
                  opts.insert ?? { data: { id: "new-row", ...(row as object) }, error: null },
              };
            },
          };
        },
        delete() {
          deleteCount += 1;
          const which = deleteCount === 1 ? opts.delete : opts.cleanup;
          calls.push(deleteCount === 1 ? "delete-old" : "delete-cleanup");
          return {
            neq: async () => which ?? { error: null },
            eq: async () => which ?? { error: null },
          };
        },
      };
    },
  };
  return { client, calls };
}

const ROW = { access_token: "a", refresh_token: "r", token_expiry: "2026-01-01T00:00:00Z" };

/**
 * Narrow the discriminated union, and fail loudly if it went the other way.
 * `expect(result.ok).toBe(false)` does not narrow for TypeScript, and casting
 * the result to reach `.error` would throw away the very typing that forces a
 * caller to check `ok` before trusting anything else on it.
 */
function failure(result: Awaited<ReturnType<typeof replaceSingletonToken>>): string {
  if (result.ok) throw new Error("expected a failure, got ok:true");
  return result.error;
}

describe("replaceSingletonToken", () => {
  it("inserts BEFORE deleting, so a failed insert cannot destroy a working connection", async () => {
    const { client, calls } = fakeDb({});
    await replaceSingletonToken(client as never, "xero_tokens", ROW);
    expect(calls[0]).toBe("insert");
  });

  it("reports failure when the insert fails, and deletes nothing", async () => {
    const { client, calls } = fakeDb({ insert: { data: null, error: { message: "RLS denied" } } });
    const result = await replaceSingletonToken(client as never, "xero_tokens", ROW);

    expect(result.ok).toBe(false);
    expect(failure(result)).toMatch(/RLS denied/);
    // The whole point: the old tokens are still there.
    expect(calls).toEqual(["insert"]);
  });

  it("removes the previous rows once the new one is safely in", async () => {
    const { client, calls } = fakeDb({});
    const result = await replaceSingletonToken(client as never, "xero_tokens", ROW);

    expect(result.ok).toBe(true);
    expect(calls).toEqual(["insert", "delete-old"]);
  });

  it("undoes its own insert if the cleanup fails, rather than leaving two rows", async () => {
    // Two rows is not a lesser evil here: lib/xero.ts:78 reads with .single(),
    // which errors on 2 rows exactly as it does on 0. Leaving two would break
    // the integration just as thoroughly, but silently and for both tokens.
    const { client, calls } = fakeDb({ delete: { error: { message: "delete blew up" } } });
    const result = await replaceSingletonToken(client as never, "xero_tokens", ROW);

    expect(result.ok).toBe(false);
    expect(failure(result)).toMatch(/delete blew up/);
    expect(calls).toEqual(["insert", "delete-old", "delete-cleanup"]);
  });

  it("says so when even the compensating delete fails — the one state a human must fix", async () => {
    const { client } = fakeDb({
      delete: { error: { message: "delete blew up" } },
      cleanup: { error: { message: "cleanup blew up" } },
    });
    const result = await replaceSingletonToken(client as never, "xero_tokens", ROW);

    expect(result.ok).toBe(false);
    expect(failure(result)).toMatch(/more than one/i);
  });

  it("never reports success on any failure path", async () => {
    const failures: Array<Parameters<typeof fakeDb>[0]> = [
      { insert: { data: null, error: { message: "x" } } },
      { delete: { error: { message: "x" } } },
      { delete: { error: { message: "x" } }, cleanup: { error: { message: "y" } } },
    ];
    for (const f of failures) {
      const { client } = fakeDb(f);
      const result = await replaceSingletonToken(client as never, "xero_tokens", ROW);
      expect(result.ok).toBe(false);
    }
  });
});
