import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertLocalStack } from "./env";
import { makeUser, deleteUser, adminClient } from "./helpers";
import { approveJob } from "@/lib/approve-job";
import { applyInvoiceHours, loadInvoiceHours } from "@/lib/invoice-hours";

// THE WHOLE PATH, against a real database (migration 0098), as the apps do it:
//
//   technicians clock on and off  ->  one corrects their clock-off (the manual
//   adjustment)  ->  the job is completed  ->  it lands in Approvals  ->  an admin
//   approves  ->  the draft invoice carries the hours  ->  "Apply hourly rate"
//   bills them, grouped by cost centre and technician  ->  billed hours lock.
//
// Bug it guards (14 Nov 2026, Garden World #505 / #2542): every step up to the
// approval worked and the invoice still came out with no hours on it. Each
// step is run through the same code the routes run (lib/approve-job.ts,
// lib/invoice-hours.ts), signed in as the user who would click it — not the
// service role, which would skip the RLS and triggers that matter here.

type U = { client: SupabaseClient; id: string };
let admin: U, techA: U, techB: U;
const service = adminClient();
const ids: { customer?: string; job?: string; po?: string; cc1?: string; cc2?: string; invoice?: string } = {};
const day = "2026-11-10"; // a Tuesday; times are UTC, the band split is not under test

const at = (hhmm: string) => `${day}T${hhmm}:00Z`;

beforeAll(async () => {
  assertLocalStack();
  admin = await makeUser("admin", "rls-hours-admin@test.local");
  techA = await makeUser("technician", "rls-hours-tech-a@test.local");
  techB = await makeUser("technician", "rls-hours-tech-b@test.local");

  const { data: cust, error: ce } = await service.from("customers").insert({ name: "Hours Path Customer" }).select("id").single();
  if (ce) throw ce;
  ids.customer = cust.id;
  const { data: job, error: je } = await service
    .from("jobs")
    .insert({ customer_id: cust.id, title: "Hours path job", assigned_to: techA.id, status: "in_progress" })
    .select("id")
    .single();
  if (je) throw je;
  ids.job = job.id;
  const { error: ae } = await service.from("job_assignments").upsert([
    { job_id: job.id, staff_id: techA.id },
    { job_id: job.id, staff_id: techB.id },
  ], { onConflict: "job_id,staff_id" });
  if (ae) throw ae;
  const { data: po, error: pe } = await service.from("purchase_orders").insert({ job_id: job.id, po_number: "HOURS-PATH-1" }).select("id").single();
  if (pe) throw pe;
  ids.po = po.id;
  const { data: ccs, error: cce } = await service
    .from("po_cost_centers")
    .insert([
      { po_id: po.id, name: "Rough In", sort_order: 0 },
      { po_id: po.id, name: "Fit Off", sort_order: 1 },
    ])
    .select("id, name");
  if (cce) throw cce;
  ids.cc1 = ccs.find((c) => c.name === "Rough In")!.id;
  ids.cc2 = ccs.find((c) => c.name === "Fit Off")!.id;
});

afterAll(async () => {
  if (ids.invoice) {
    await service.from("time_entries").update({ invoice_id: null }).eq("invoice_id", ids.invoice);
    await service.from("invoice_items").delete().eq("invoice_id", ids.invoice);
    await service.from("invoices").delete().eq("id", ids.invoice);
  }
  if (ids.job) {
    await service.from("time_entries").delete().eq("job_id", ids.job);
    await service.from("jobs").delete().eq("id", ids.job);
  }
  if (ids.customer) await service.from("customers").delete().eq("id", ids.customer);
  for (const u of [admin, techA, techB]) if (u) await deleteUser(u.id);
});

describe("clock hours -> adjust -> complete -> approve -> invoice", () => {
  let a1: string;

  it("technicians clock on and off, and one corrects a clock-off", async () => {
    // Tech A clocks on to Rough In...
    const on = await techA.client
      .from("time_entries")
      .insert({ job_id: ids.job!, staff_id: techA.id, entry_type: "work", clock_in: at("08:00"), cost_center_id: ids.cc1 })
      .select("id")
      .single();
    expect(on.error).toBeNull();
    a1 = on.data!.id;
    // ...clocks off at 09:00...
    expect((await techA.client.from("time_entries").update({ clock_out: at("09:00"), hours: 1 }).eq("id", a1)).error).toBeNull();
    // ...then corrects it: they actually finished at 10:30 (the manual adjustment).
    expect((await techA.client.from("time_entries").update({ clock_out: at("10:30"), hours: 2.5 }).eq("id", a1)).error).toBeNull();

    // A manual entry on Fit Off, and Tech B's hours on Rough In.
    expect(
      (await techA.client.from("time_entries").insert({ job_id: ids.job!, staff_id: techA.id, entry_type: "work", clock_in: at("11:00"), clock_out: at("12:15"), hours: 1.25, cost_center_id: ids.cc2 })).error
    ).toBeNull();
    expect(
      (await techB.client.from("time_entries").insert({ job_id: ids.job!, staff_id: techB.id, entry_type: "work", clock_in: at("08:00"), clock_out: at("11:00"), hours: 3, cost_center_id: ids.cc1 })).error
    ).toBeNull();
    // Travel is not billed by the hour.
    expect(
      (await techB.client.from("time_entries").insert({ job_id: ids.job!, staff_id: techB.id, entry_type: "travel", clock_in: at("07:30"), clock_out: at("08:00"), hours: 0.5 })).error
    ).toBeNull();
  });

  it("completing the job sends it to Approvals", async () => {
    // Start from 'approved', the state every Simpro-imported job is in — the
    // Garden World case. Completing must still put it in front of the office.
    await service.from("jobs").update({ admin_status: "approved" }).eq("id", ids.job!);
    expect((await techA.client.from("jobs").update({ status: "completed" }).eq("id", ids.job!)).error).toBeNull();
    const { data } = await service.from("jobs").select("admin_status").eq("id", ids.job!).single();
    expect(data!.admin_status).toBe("pending");
  });

  it("approving creates a draft invoice that carries the hours, unpriced", async () => {
    const r = await approveJob(admin.client, { jobId: ids.job!, approverId: admin.id });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    if (!r.ok) return;
    ids.invoice = r.invoiceId!;
    expect(r.invoiceCreated).toBe(true);
    expect(r.unpricedHours).toBe(6.75); // 2.5 + 1.25 + 3, no travel
    expect(r.hoursGroups.map((g) => [g.costCentreName, g.staffId, g.hours])).toEqual(
      expect.arrayContaining([
        ["Rough In", techA.id, 2.5],
        ["Rough In", techB.id, 3],
        ["Fit Off", techA.id, 1.25],
      ])
    );

    const { data: job } = await service.from("jobs").select("admin_status, ready_to_invoice").eq("id", ids.job!).single();
    expect(job).toEqual({ admin_status: "approved", ready_to_invoice: false });

    // Approving twice is refused, not a second invoice.
    const again = await approveJob(admin.client, { jobId: ids.job!, approverId: admin.id });
    expect(again.ok).toBe(false);
  });

  it("the invoice shows the hours by cost centre and technician, with a default rate", async () => {
    const view = await loadInvoiceHours(admin.client, service, ids.invoice!);
    expect(view!.unbilledHours).toBe(6.75);
    expect(view!.groups).toHaveLength(3);
    const { data: cfg } = await service.from("billing_rate_config").select("qualified_base_rate").eq("id", true).maybeSingle();
    expect(view!.defaults!.all).toBe(cfg ? Number(cfg.qualified_base_rate) : 130);
  });

  it("Apply hourly rate (per technician) bills one line per cost centre x technician", async () => {
    const r = await applyInvoiceHours(admin.client, ids.invoice!, {
      mode: "technician",
      byStaff: { [techA.id]: 120, [techB.id]: 100 },
    });
    expect(r.ok, r.ok ? "" : r.error).toBe(true);

    const { data: lines } = await service
      .from("invoice_items")
      .select("name, quantity, unit_price, source")
      .eq("invoice_id", ids.invoice!);
    expect((lines ?? []).map((l) => [l.name, Number(l.quantity), Number(l.unit_price), l.source])).toEqual(
      expect.arrayContaining([
        ["Labour — Rough In", 2.5, 120, "hours"],
        ["Labour — Rough In", 3, 100, "hours"],
        ["Labour — Fit Off", 1.25, 120, "hours"],
      ])
    );
    // 2.5*120 + 3*100 + 1.25*120 = 750; GST 75.
    const { data: inv } = await service.from("invoices").select("subtotal, tax_amount, total").eq("id", ids.invoice!).single();
    expect([Number(inv!.subtotal), Number(inv!.tax_amount), Number(inv!.total)]).toEqual([750, 75, 825]);

    const { data: billed } = await service.from("time_entries").select("entry_type, invoice_id").eq("job_id", ids.job!);
    expect(billed!.filter((e) => e.entry_type === "work").every((e) => e.invoice_id === ids.invoice)).toBe(true);
    expect(billed!.filter((e) => e.entry_type === "travel").every((e) => e.invoice_id === null)).toBe(true);
  });

  it("re-applying one rate for all replaces the hours lines instead of adding more", async () => {
    const r = await applyInvoiceHours(admin.client, ids.invoice!, { mode: "all", all: 130 });
    expect(r.ok).toBe(true);
    const { count } = await service.from("invoice_items").select("id", { count: "exact", head: true }).eq("invoice_id", ids.invoice!);
    expect(count).toBe(3);
    const { data: inv } = await service.from("invoices").select("total").eq("id", ids.invoice!).single();
    expect(Number(inv!.total)).toBe(965.25); // 6.75h * 130 = 877.50 + GST 87.75
  });

  it("billed hours are locked to the technician", async () => {
    const { error } = await techA.client.from("time_entries").update({ clock_out: at("11:30") }).eq("id", a1);
    expect(error?.message).toMatch(/billed/i);
  });

  it("a technician cannot bill hours themselves", async () => {
    const { error } = await techA.client.rpc("apply_invoice_hours", { p_invoice_id: ids.invoice!, p_lines: [] });
    expect(error).not.toBeNull();
  });
});
