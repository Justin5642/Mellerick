import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertLocalStack } from "./env";
import { makeUser, deleteUser, type Role } from "./helpers";

// Regression cover for the 0027/0028 financial-table restrictions: technicians
// must not read the priced tables (invoices, quotes, pricing_items). These
// policies have never had automated tests. Requires a local Supabase stack.

const users: Partial<Record<Role, { client: SupabaseClient; id: string }>> = {};

beforeAll(async () => {
  assertLocalStack();
  users.office = await makeUser("office", "rls-fin-office@test.local");
  users.technician = await makeUser("technician", "rls-fin-tech@test.local");
});

afterAll(async () => {
  for (const u of Object.values(users)) if (u) await deleteUser(u.id);
});

const RESTRICTED_TABLES = ["invoices", "quotes", "pricing_items"] as const;

describe("financial tables are office/admin-only for SELECT (migrations 0027/0028)", () => {
  for (const table of RESTRICTED_TABLES) {
    it(`${table}: technician read returns no rows`, async () => {
      const { data } = await users.technician!.client.from(table).select("id");
      expect(data ?? []).toHaveLength(0);
    });

    it(`${table}: office read is permitted (no RLS error)`, async () => {
      const { error } = await users.office!.client.from(table).select("id").limit(1);
      expect(error).toBeNull();
    });
  }
});
