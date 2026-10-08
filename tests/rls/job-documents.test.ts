import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertLocalStack } from "./env";
import { makeUser, adminClient, deleteUser, type Role } from "./helpers";

// Proves migration 0065: a technician cannot see an office-only job document
// — neither its row nor its FILE — while ordinary documents stay readable, and
// mobile expense receipts ('<job>/expense-<id>.jpg') are office/admin only.
//
// Requires a running local Supabase stack — see `npm run test:rls`.

const users: Partial<Record<Role, { client: SupabaseClient; id: string }>> = {};
let customerId = "";
let jobId = "";
const paths = { general: "", officeOnly: "", mobileReceipt: "" };
let officeOnlyDocId = "";

beforeAll(async () => {
  assertLocalStack();
  const admin = adminClient();
  const { data: customer, error: cErr } = await admin.from("customers").insert({ name: "RLS docs customer" }).select("id").single();
  if (cErr) throw cErr;
  customerId = customer.id;
  const { data: job, error: jErr } = await admin.from("jobs").insert({ customer_id: customerId, title: "RLS docs job" }).select("id").single();
  if (jErr) throw jErr;
  jobId = job.id;

  paths.general = `${jobId}/1700000000_plans.pdf`;
  paths.officeOnly = `${jobId}/simpro-1-purchase-order.pdf`;
  paths.mobileReceipt = `${jobId}/expense-abc.jpg`;
  for (const p of Object.values(paths)) {
    const { error } = await admin.storage.from("job-documents").upload(p, new Blob(["x"], { type: "application/pdf" }), { upsert: true });
    if (error) throw error;
  }
  const { data: docs, error: dErr } = await admin
    .from("job_documents")
    .insert([
      { job_id: jobId, storage_path: paths.general, file_name: "plans.pdf" },
      { job_id: jobId, storage_path: paths.officeOnly, file_name: "purchase-order.pdf", office_only: true },
    ])
    .select("id, office_only");
  if (dErr) throw dErr;
  officeOnlyDocId = docs!.find((d) => d.office_only)!.id;

  users.office = await makeUser("office", "rls-docs-office@test.local");
  users.technician = await makeUser("technician", "rls-docs-tech@test.local");
});

afterAll(async () => {
  const admin = adminClient();
  await admin.storage.from("job-documents").remove(Object.values(paths).filter(Boolean));
  if (customerId) await admin.from("customers").delete().eq("id", customerId); // cascades to jobs + job_documents
  for (const u of Object.values(users)) if (u) await deleteUser(u.id);
});

describe("job_documents office-only (migration 0065)", () => {
  it("hides office-only rows from a technician but shows ordinary ones", async () => {
    const { data, error } = await users.technician!.client.from("job_documents").select("file_name").eq("job_id", jobId);
    expect(error).toBeNull();
    expect(data).toEqual([{ file_name: "plans.pdf" }]);
  });

  it("shows office every document", async () => {
    const { data } = await users.office!.client.from("job_documents").select("file_name").eq("job_id", jobId);
    expect((data ?? []).map((d) => d.file_name).sort()).toEqual(["plans.pdf", "purchase-order.pdf"]);
  });

  it("refuses a technician un-hiding an office-only row", async () => {
    const { data } = await users.technician!.client.from("job_documents").update({ office_only: false }).eq("id", officeOnlyDocId).select();
    expect(data ?? []).toHaveLength(0);
    const { data: row } = await adminClient().from("job_documents").select("office_only").eq("id", officeOnlyDocId).single();
    expect(row).toEqual({ office_only: true });
  });

  it("refuses a technician the office-only FILE and the mobile receipt", async () => {
    const tech = users.technician!.client.storage.from("job-documents");
    expect((await tech.createSignedUrl(paths.officeOnly, 60)).error).not.toBeNull();
    expect((await tech.createSignedUrl(paths.mobileReceipt, 60)).error).not.toBeNull();
  });

  it("still lets a technician open an ordinary document file", async () => {
    const { data, error } = await users.technician!.client.storage.from("job-documents").createSignedUrl(paths.general, 60);
    expect(error).toBeNull();
    expect(data?.signedUrl).toBeTruthy();
  });

  it("lets office open the office-only file", async () => {
    const { error } = await users.office!.client.storage.from("job-documents").createSignedUrl(paths.officeOnly, 60);
    expect(error).toBeNull();
  });
});
