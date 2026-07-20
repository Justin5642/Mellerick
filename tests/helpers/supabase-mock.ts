import { vi } from "vitest";

// Minimal builders for the Supabase surfaces the guards + routes touch. These
// return plain vi.fn()-backed objects so tests can assert call contracts
// (e.g. "the admin client was never constructed on a 403") without a real DB.

// A thenable query-chain stub: every builder method returns the same object,
// and the terminal reads (single/maybeSingle) resolve to the queued result.
// Good enough for the read-one-row and simple update/insert/delete patterns
// the routes use.
export function queryResult(result: { data?: unknown; error?: unknown }) {
  const res = { data: result.data ?? null, error: result.error ?? null };
  const chain: Record<string, unknown> = {};
  const methods = [
    "select", "insert", "update", "delete", "upsert",
    "eq", "neq", "in", "not", "is", "order", "limit", "match",
  ];
  for (const m of methods) chain[m] = vi.fn(() => chain);
  chain.single = vi.fn(async () => res);
  chain.maybeSingle = vi.fn(async () => res);
  chain.then = (resolve: (v: typeof res) => unknown) => resolve(res);
  return chain;
}

// A Supabase-ish client whose `.from(table)` returns a per-table queued result.
export function mockClient(tables: Record<string, { data?: unknown; error?: unknown }> = {}) {
  const from = vi.fn((table: string) => queryResult(tables[table] ?? { data: null }));
  return { from } as unknown as {
    from: ReturnType<typeof vi.fn>;
  };
}

// A session/server client whose auth.getUser resolves to the given user.
export function mockSessionClient(user: { id: string } | null, tables: Record<string, { data?: unknown; error?: unknown }> = {}) {
  return {
    auth: { getUser: vi.fn(async () => ({ data: { user }, error: null })) },
    from: vi.fn((table: string) => queryResult(tables[table] ?? { data: null })),
  };
}
