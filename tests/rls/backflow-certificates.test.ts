import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { assertLocalStack, TEST_URL, TEST_ANON_KEY } from "./env";
import { makeUser, adminClient, deleteUser } from "./helpers";

// Proves migration 0066 (drafted, not yet applied to production) on the
// backflow-certificates storage bucket:
//   - a technician can upload a signature the way the WEB does (plain upload)
//     and the way the MOBILE outbox does (upsert, replayed to the same key);
//   - nobody can plant a certificate PDF or a signature for a device that does
//     not exist, or overwrite someone else's signature;
//   - office/admin can open a certificate, a technician cannot (they go through
//     the service-role certificate route), anon gets nothing.
//
// Requires a running local Supabase stack — see `npm run test:rls`.

const BUCKET = "backflow-certificates";
const png = (s: string) => new Blob([s], { type: "image/png" });

let tech: { client: SupabaseClient; id: string };
let tech2: { client: SupabaseClient; id: string };
let office: { client: SupabaseClient; id: string };
let customerId = "";
let deviceId = "";
let certificatePath = "";
const written: string[] = [];

beforeAll(async () => {
  assertLocalStack();
  const admin = adminClient();
  const { data: customer, error: cErr } = await admin.from("customers").insert({ name: "RLS backflow customer" }).select("id").single();
  if (cErr) throw cErr;
  customerId = customer.id;
  const { data: device, error: dErr } = await admin
    .from("backflow_devices")
    .insert({ customer_id: customerId, water_authority: "yarra_valley_water", device_type: "rpzd" })
    .select("id")
    .single();
  if (dErr) throw dErr;
  deviceId = device.id;

  // Written by the service-role submit route in the app; seeded the same way.
  certificatePath = `${deviceId}/${randomUUID()}_1700000000000.pdf`;
  const { error: upErr } = await admin.storage
    .from(BUCKET)
    .upload(certificatePath, new Blob(["%PDF"], { type: "application/pdf" }), { upsert: true });
  if (upErr) throw upErr;
  written.push(certificatePath);

  tech = await makeUser("technician", "rls-backflow-tech@test.local");
  tech2 = await makeUser("technician", "rls-backflow-tech2@test.local");
  office = await makeUser("office", "rls-backflow-office@test.local");
});

afterAll(async () => {
  const admin = adminClient();
  if (written.length) await admin.storage.from(BUCKET).remove(written);
  if (customerId) await admin.from("customers").delete().eq("id", customerId); // cascades to the device
  for (const u of [tech, tech2, office]) if (u) await deleteUser(u.id);
});

describe("backflow-certificates storage (migration 0066, draft)", () => {
  it("lets a technician upload a signature the way the web test form does", async () => {
    const path = `${deviceId}/signatures/${Date.now()}.png`;
    written.push(path);
    const { error } = await tech.client.storage.from(BUCKET).upload(path, png("web"), { contentType: "image/png" });
    expect(error).toBeNull();
  });

  it("lets a technician upload a signature the way the mobile outbox does, and replay it", async () => {
    const path = `${deviceId}/signatures/${randomUUID()}.png`;
    written.push(path);
    const first = await tech.client.storage.from(BUCKET).upload(path, png("first"), { contentType: "image/png", upsert: true });
    expect(first.error).toBeNull();
    // An offline replay re-uploads to the SAME key.
    const replay = await tech.client.storage.from(BUCKET).upload(path, png("replay"), { contentType: "image/png", upsert: true });
    expect(replay.error).toBeNull();
  });

  it("refuses a second technician overwriting someone else's signature", async () => {
    const path = `${deviceId}/signatures/${randomUUID()}.png`;
    written.push(path);
    expect((await tech.client.storage.from(BUCKET).upload(path, png("original"), { upsert: true })).error).toBeNull();

    await tech2.client.storage.from(BUCKET).upload(path, png("forged"), { upsert: true });
    const { data } = await adminClient().storage.from(BUCKET).download(path);
    expect(await data!.text()).toBe("original");
  });

  it("refuses a technician planting a certificate PDF", async () => {
    const path = `${deviceId}/${randomUUID()}_1700000000001.pdf`;
    written.push(path);
    const { error } = await tech.client.storage
      .from(BUCKET)
      .upload(path, new Blob(["%PDF forged"], { type: "application/pdf" }), { upsert: true });
    expect(error).not.toBeNull();
  });

  it("refuses a signature for a device that does not exist", async () => {
    const path = `${randomUUID()}/signatures/x.png`;
    written.push(path);
    const { error } = await tech.client.storage.from(BUCKET).upload(path, png("x"));
    expect(error).not.toBeNull();
  });

  it("refuses a technician opening a certificate directly", async () => {
    const { error } = await tech.client.storage.from(BUCKET).createSignedUrl(certificatePath, 60);
    expect(error).not.toBeNull();
  });

  it("refuses a technician deleting a certificate", async () => {
    await tech.client.storage.from(BUCKET).remove([certificatePath]);
    const { error } = await adminClient().storage.from(BUCKET).download(certificatePath);
    expect(error).toBeNull();
  });

  it("lets office open a certificate and upload a signature", async () => {
    const signed = await office.client.storage.from(BUCKET).createSignedUrl(certificatePath, 60);
    expect(signed.error).toBeNull();
    expect(signed.data?.signedUrl).toBeTruthy();

    const path = `${deviceId}/signatures/${Date.now()}-office.png`;
    written.push(path);
    expect((await office.client.storage.from(BUCKET).upload(path, png("office"))).error).toBeNull();
  });

  it("gives anon nothing", async () => {
    const anon = createClient(TEST_URL, TEST_ANON_KEY, { auth: { persistSession: false } });
    const path = `${deviceId}/signatures/${Date.now()}-anon.png`;
    written.push(path);
    expect((await anon.storage.from(BUCKET).upload(path, png("anon"))).error).not.toBeNull();
    expect((await anon.storage.from(BUCKET).createSignedUrl(certificatePath, 60)).error).not.toBeNull();
  });
});
