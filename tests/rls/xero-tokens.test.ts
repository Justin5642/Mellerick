import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertLocalStack } from "./env";
import { makeUser, adminClient, deleteUser, type Role } from "./helpers";

// Proves migration 0034: xero_tokens (Xero OAuth tokens) is readable/writable
// only by office/admin, never by a technician. This is the regression test for
// the "unverified xero_tokens RLS" security finding.
//
// Requires a running local Supabase stack — see `npm run test:rls`.

const users: Partial<Record<Role, { client: SupabaseClient; id: string }>> = {};

beforeAll(async () => {
  assertLocalStack();

  // Seed one token row via the service-role client (bypasses RLS).
  const admin = adminClient();
  await admin.from("xero_tokens").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await admin.from("xero_tokens").insert({
    access_token: "seed-access",
    refresh_token: "seed-refresh",
    token_expiry: new Date(Date.now() + 3_600_000).toISOString(),
    tenant_id: "seed-tenant",
  });

  users.admin = await makeUser("admin", "rls-admin@test.local");
  users.office = await makeUser("office", "rls-office@test.local");
  users.technician = await makeUser("technician", "rls-tech@test.local");
});

afterAll(async () => {
  for (const u of Object.values(users)) if (u) await deleteUser(u.id);
});

describe("xero_tokens RLS (migration 0034)", () => {
  it("lets an admin read the token row", async () => {
    const { data, error } = await users.admin!.client.from("xero_tokens").select("id, tenant_id");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
  });

  it("lets an office user read the token row", async () => {
    const { data, error } = await users.office!.client.from("xero_tokens").select("id");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThan(0);
  });

  it("returns NO rows to a technician (RLS blocks the read)", async () => {
    const { data } = await users.technician!.client.from("xero_tokens").select("id, access_token");
    // Under RLS a blocked select yields an empty set, not an error.
    expect(data ?? []).toHaveLength(0);
  });

  it("prevents a technician from updating account-code config", async () => {
    const { data } = await users.technician!.client
      .from("xero_tokens")
      .update({ default_sales_account_code: "999" })
      .neq("id", "00000000-0000-0000-0000-000000000000")
      .select();
    expect(data ?? []).toHaveLength(0); // nothing visible to update
  });
});
