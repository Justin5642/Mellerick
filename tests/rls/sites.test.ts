import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertLocalStack } from "./env";
import { makeUser, adminClient, deleteUser, type Role } from "./helpers";

// Proves migration 0064: any signed-in user can read and add sites, but only
// office/admin can update (edit/archive) or delete them.
//
// Requires a running local Supabase stack — see `npm run test:rls`.

const users: Partial<Record<Role, { client: SupabaseClient; id: string }>> = {};
let customerId = "";
let siteId = "";

const SITE = { name: "RLS site", address_line1: "1 Test St", suburb: "Testville", state: "VIC", postcode: "3000" };

beforeAll(async () => {
  assertLocalStack();
  const admin = adminClient();
  const { data: customer, error: cErr } = await admin.from("customers").insert({ name: "RLS sites customer" }).select("id").single();
  if (cErr) throw cErr;
  customerId = customer.id;
  const { data: site, error: sErr } = await admin.from("sites").insert({ ...SITE, customer_id: customerId }).select("id").single();
  if (sErr) throw sErr;
  siteId = site.id;

  users.office = await makeUser("office", "rls-sites-office@test.local");
  users.technician = await makeUser("technician", "rls-sites-tech@test.local");
});

afterAll(async () => {
  const admin = adminClient();
  if (customerId) await admin.from("customers").delete().eq("id", customerId); // cascades to sites
  for (const u of Object.values(users)) if (u) await deleteUser(u.id);
});

describe("sites RLS (migration 0064)", () => {
  it("lets a technician read sites", async () => {
    const { data, error } = await users.technician!.client.from("sites").select("id").eq("id", siteId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("lets a technician add a site", async () => {
    const { data, error } = await users.technician!.client
      .from("sites")
      .insert({ ...SITE, name: "Tech-added site", customer_id: customerId })
      .select("id");
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("refuses a technician archiving or editing a site", async () => {
    const { data } = await users.technician!.client.from("sites").update({ is_active: false, name: "hacked" }).eq("id", siteId).select();
    // Under RLS a blocked update matches zero rows rather than erroring.
    expect(data ?? []).toHaveLength(0);
    const { data: row } = await adminClient().from("sites").select("is_active, name").eq("id", siteId).single();
    expect(row).toEqual({ is_active: true, name: SITE.name });
  });

  it("refuses a technician deleting a site", async () => {
    await users.technician!.client.from("sites").delete().eq("id", siteId);
    const { data } = await adminClient().from("sites").select("id").eq("id", siteId);
    expect(data).toHaveLength(1);
  });

  it("lets office archive and restore a site", async () => {
    const archived = await users.office!.client.from("sites").update({ is_active: false }).eq("id", siteId).select("is_active");
    expect(archived.error).toBeNull();
    expect(archived.data).toEqual([{ is_active: false }]);
    const restored = await users.office!.client.from("sites").update({ is_active: true }).eq("id", siteId).select("is_active");
    expect(restored.data).toEqual([{ is_active: true }]);
  });
});
