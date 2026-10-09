import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertLocalStack } from "./env";
import { makeUser, adminClient, deleteUser } from "./helpers";

// Proves migration 0067's trigger (jobs_todo_list_autoclear): office lists a
// job by hand, the database stamps who and when, and the job leaves the list
// by itself once it is scheduled — whoever schedules it.
//
// Requires a running local Supabase stack — see `npm run test:rls`.

let office: { client: SupabaseClient; id: string } | null = null;
let customerId = "";
const jobIds: string[] = [];

async function newJob(fields: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await adminClient()
    .from("jobs")
    .insert({ customer_id: customerId, title: "RLS to-do job", ...fields })
    .select("id")
    .single();
  if (error) throw error;
  jobIds.push(data.id);
  return data.id;
}

async function row(id: string) {
  const { data, error } = await adminClient()
    .from("jobs")
    .select("todo_listed_at, todo_listed_by, estimated_hours")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}

async function list(id: string, extra: Record<string, unknown> = {}) {
  return office!.client
    .from("jobs")
    // A deliberately stale browser clock: the trigger must replace it.
    .update({ todo_listed_at: "2000-01-01T00:00:00Z", estimated_hours: 3, ...extra })
    .eq("id", id)
    .select("todo_listed_at");
}

beforeAll(async () => {
  assertLocalStack();
  const { data: customer, error } = await adminClient().from("customers").insert({ name: "RLS to-do customer" }).select("id").single();
  if (error) throw error;
  customerId = customer.id;
  office = await makeUser("office", "rls-todo-office@test.local");
});

afterAll(async () => {
  const admin = adminClient();
  if (jobIds.length) await admin.from("jobs").delete().in("id", jobIds);
  if (customerId) await admin.from("customers").delete().eq("id", customerId);
  if (office) await deleteUser(office.id);
});

describe("jobs to-do list trigger (migration 0067)", () => {
  it("lists a pending job, stamping the database clock and the caller", async () => {
    const id = await newJob();
    const before = Date.now();
    const { error } = await list(id);
    expect(error).toBeNull();
    const r = await row(id);
    expect(r.todo_listed_by).toBe(office!.id);
    expect(Number(r.estimated_hours)).toBe(3);
    // Not the year-2000 value the client sent.
    expect(new Date(r.todo_listed_at!).getTime()).toBeGreaterThan(before - 60_000);
  });

  it("takes the job off the list when scheduled_start is set", async () => {
    const id = await newJob();
    await list(id);
    expect((await row(id)).todo_listed_at).not.toBeNull();

    const { error } = await office!.client.from("jobs").update({ scheduled_start: new Date().toISOString() }).eq("id", id);
    expect(error).toBeNull();
    const r = await row(id);
    expect(r.todo_listed_at).toBeNull();
    expect(r.todo_listed_by).toBeNull();
    // The estimate is the job's, not the list's — it survives.
    expect(Number(r.estimated_hours)).toBe(3);
  });

  it("takes the job off the list when a service-role writer (calendar sync) schedules it", async () => {
    const id = await newJob();
    await list(id);
    await adminClient().from("jobs").update({ status: "scheduled" }).eq("id", id);
    expect((await row(id)).todo_listed_at).toBeNull();
  });

  it("refuses to list a job that is already scheduled", async () => {
    const id = await newJob({ status: "scheduled", scheduled_start: new Date().toISOString() });
    const { data, error } = await list(id);
    expect(error).toBeNull();
    expect(data).toEqual([{ todo_listed_at: null }]);
  });

  it("keeps an on-hold job with an old date listed until it is rescheduled", async () => {
    const id = await newJob({ status: "on_hold", scheduled_start: "2026-01-01T00:00:00Z" });
    await list(id);
    expect((await row(id)).todo_listed_at).not.toBeNull();
    // An unrelated edit keeps it listed, with its original stamp.
    const stamp = (await row(id)).todo_listed_at;
    await office!.client.from("jobs").update({ notes: "edited" }).eq("id", id);
    expect((await row(id)).todo_listed_at).toBe(stamp);
    // A new date takes it off.
    await office!.client.from("jobs").update({ scheduled_start: "2026-12-01T00:00:00Z" }).eq("id", id);
    expect((await row(id)).todo_listed_at).toBeNull();
  });

  it("rejects an estimate outside 0..1000 hours", async () => {
    const id = await newJob();
    const { error } = await office!.client.from("jobs").update({ estimated_hours: 1001 }).eq("id", id);
    expect(error?.code).toBe("23514");
  });
});
