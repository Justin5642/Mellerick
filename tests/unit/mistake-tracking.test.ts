import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildRaiseBody, emptyRaiseForm, mistakeRpcError, parseRaiseBody, mistakePhotoPath, MISTAKE_CAUSES } from "@/lib/mistake-raise";
import { buildManualLine, buildRecovery, costLine, emptySources, ledgerMistake, linkedKeys, mistakeMoney, type CostSources } from "@/lib/mistake-costs";
import { groupMistakes, mistakesByJob, mistakesByMonth, openItems, openRecoverable, NONE, type MoneyMistake } from "@/lib/mistakes-report";
import { legacyLines, type TrackedMistake } from "@/lib/mistakes-data";
import { summariseDigestMistakes } from "@/lib/mistakes-digest";
import { buildDigest } from "@/lib/weekly-digest";

// Cost of mistakes, stages 1–4 (Justin, 25 Nov 2026; migration 0119).

const ID = "33333333-3333-4333-8333-333333333333";
const CAT = "22222222-2222-4222-8222-222222222222";
const E1 = "44444444-4444-4444-8444-444444444444";

describe("raising a mistake (crew)", () => {
  const form = { ...emptyRaiseForm(), categoryId: CAT, description: "  Pit 50 mm high ", timeEntryIds: [E1, E1] };

  it("builds the request, trimmed and de-duplicated", () => {
    expect(buildRaiseBody(ID, form, "2026-11-25")).toEqual({
      ok: true,
      body: { id: ID, categoryId: CAT, causeCode: null, costCenterId: null, description: "Pit 50 mm high", occurredOn: null, timeEntryIds: [E1] },
    });
  });

  it("asks for a category and a description, refuses a future date and an unknown cause", () => {
    expect(buildRaiseBody(ID, { ...form, categoryId: "" }, "2026-11-25").ok).toBe(false);
    expect(buildRaiseBody(ID, { ...form, description: "  " }, "2026-11-25")).toEqual({ ok: false, error: "Say what went wrong." });
    expect(buildRaiseBody(ID, { ...form, occurredOn: "2026-11-26" }, "2026-11-25")).toEqual({ ok: false, error: "The date can't be in the future." });
    expect(buildRaiseBody(ID, { ...form, causeCode: "bribery" }, "2026-11-25").ok).toBe(false);
  });

  it("the route accepts what the form builds and refuses junk", () => {
    const built = buildRaiseBody(ID, { ...form, causeCode: "install", costCenterId: E1, occurredOn: "2026-11-20" }, "2026-11-25");
    expect(built.ok && parseRaiseBody(built.body)).toEqual(built.ok && built.body);
    expect(parseRaiseBody(null)).toBeNull();
    expect(parseRaiseBody({ ...form, id: "nope", categoryId: CAT })).toBeNull();
    expect(parseRaiseBody({ id: ID, categoryId: CAT, description: "x", timeEntryIds: ["not-a-uuid"] })).toBeNull();
    expect(parseRaiseBody({ id: ID, categoryId: CAT, description: "x".repeat(2001) })).toBeNull();
  });

  it("the cause list is the database's (0119's cause_code check)", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/0119_mistake_tracking.sql"), "utf8");
    for (const c of MISTAKE_CAUSES) expect(sql).toContain(`'${c.value}'`);
  });

  it("maps database codes to fixed sentences", () => {
    expect(mistakeRpcError({ code: "MJ123" })).toEqual({ status: 403, error: "This job isn't one of yours." });
    expect(mistakeRpcError({ code: "PGRST202" }).status).toBe(409);
    expect(mistakeRpcError({ code: "P0001" }).status).toBe(500);
  });

  it("puts photos under the mistake (the path add_job_mistake_photo accepts)", () => {
    expect(mistakePhotoPath("job", ID, "jpg", 5)).toBe(`job/mistakes/${ID}/5.jpg`);
  });

  it("is mirrored byte for byte on the phone", () => {
    const fromExport = (p: string) => {
      const lines = readFileSync(join(process.cwd(), p), "utf8").split("\n");
      return lines.slice(lines.findIndex((l) => l.startsWith("export "))).join("\n");
    };
    expect(fromExport("mobile/lib/mistakeRaise.ts")).toBe(fromExport("lib/mistake-raise.ts"));
  });
});

describe("what a mistake cost", () => {
  const src = (over: Partial<CostSources> = {}): CostSources => ({
    ...emptySources(),
    timeEntries: new Map([["t1", { staff_id: "s1", hours: 8 }]]),
    ratesByStaff: new Map([["s1", 90]]),
    expenses: new Map([["e1", { amount: 300 }]]),
    vendorOrders: new Map([
      ["o1", { amount: 0, status: "ordered" }],
      ["o2", { amount: 500, status: "cancelled" }],
    ]),
    usage: new Map([["u1", 120]]),
    hire: new Map([["h1", null]]),
    ...over,
  });
  const line = (source: string, source_id: string | null, extra: object = {}) => ({ source, source_id, hours: null, amount_ex_gst: null, ...extra });

  it("costs links from their source, manual lines as entered", () => {
    expect(costLine(line("time_entry", "t1"), src())).toMatchObject({ amount: 720, status: "ok", hours: 8, linked: true });
    expect(costLine(line("time_entry", "t1", { hours: 2 }), src())).toMatchObject({ amount: 180, hours: 2 });
    expect(costLine(line("time_entry", "t1", { hours: 20 }), src()).hours).toBe(8);
    expect(costLine(line("job_expense", "e1"), src()).amount).toBe(300);
    expect(costLine(line("vendor_order", "o1"), src()).status).toBe("unpriced");
    expect(costLine(line("vendor_order", "o2"), src()).amount).toBe(0);
    expect(costLine(line("equipment_usage", "u1"), src()).amount).toBe(120);
    expect(costLine(line("hire_entry", "h1"), src()).status).toBe("unpriced");
    expect(costLine(line("job_expense", "gone"), src()).status).toBe("missing");
    expect(costLine(line("manual", null, { amount_ex_gst: 85.5 }), src())).toMatchObject({ amount: 85.5, linked: false });
  });

  it("hides labour cost from office (no rates) but keeps the hours", () => {
    expect(costLine(line("time_entry", "t1"), src({ ratesByStaff: null }))).toMatchObject({ amount: 0, status: "hidden", hours: 8 });
    expect(mistakeMoney([line("time_entry", "t1")], {}, src({ ratesByStaff: null })).hiddenHours).toBe(8);
  });

  it("adds manual and linked, takes off what came back", () => {
    const m = mistakeMoney([line("time_entry", "t1"), line("manual", null, { amount_ex_gst: 100 }), line("vendor_order", "o1")], { recovered_ex_gst: 50, recovery_claimed_ex_gst: 80 }, src());
    expect(m).toEqual({ manual: 100, linked: 720, gross: 820, recovered: 50, claimed: 80, net: 770, unpriced: 1, hiddenHours: 0 });
    expect(ledgerMistake({ cost_center_id: "l1", recovered_ex_gst: 50 }, [line("manual", null, { amount_ex_gst: 100 }), line("job_expense", "e1")], src())).toEqual({
      cost_center_id: "l1",
      manual: 100,
      linked: 300,
      recovered: 50,
    });
  });

  it("knows which records are already linked", () => {
    expect([...linkedKeys([line("job_expense", "e1"), line("manual", null)])]).toEqual(["job_expense:e1"]);
  });

  it("checks the office's manual line and recovery", () => {
    expect(buildManualLine({ kind: "material", amount: "$1,000.555", hours: "", note: " riser " })).toEqual({
      ok: true,
      row: { kind: "material", source: "manual", amount_ex_gst: 1000.56, hours: null, note: "riser" },
    });
    expect(buildManualLine({ kind: "material", amount: "0", hours: "", note: "" }).ok).toBe(false);
    expect(buildManualLine({ kind: "bribe", amount: "5", hours: "", note: "" }).ok).toBe(false);
    expect(buildRecovery({ source: "", claimed: "100", received: "", claimedOn: "", note: "" })).toEqual({ ok: false, error: "Pick where the money comes back from." });
    expect(buildRecovery({ source: "supplier_credit", claimed: "100", received: "40", claimedOn: "2026-11-20", note: " CN 12 " })).toEqual({
      ok: true,
      row: { recovery_source: "supplier_credit", recovery_claimed_ex_gst: 100, recovered_ex_gst: 40, recovery_claimed_on: "2026-11-20", recovery_note: "CN 12" },
    });
    expect(buildRecovery({ source: "", claimed: "", received: "", claimedOn: "", note: "" }).ok).toBe(true);
  });

  it("turns a 0115 amount into one manual line", () => {
    const m = { id: "m1", amount_ex_gst: 250, created_at: "x" } as TrackedMistake;
    expect(legacyLines([m, { ...m, id: "m2", amount_ex_gst: null }])).toEqual([
      { id: "legacy-m1", mistake_id: "m1", kind: "other", source: "manual", source_id: null, hours: null, amount_ex_gst: 250, note: null, legacy: true, created_at: "x" },
    ]);
  });
});

describe("mistake reports (0119)", () => {
  const mk = (id: string, over: Partial<MoneyMistake> & { gross?: number; recovered?: number; claimed?: number }): MoneyMistake => {
    const gross = over.gross ?? 100;
    const recovered = over.recovered ?? 0;
    return {
      id,
      job_id: "j1",
      occurred_on: "2026-11-01",
      status: "open",
      category_id: null,
      cause_code: null,
      supplier_id: null,
      ...over,
      money: { gross, recovered, claimed: over.claimed ?? 0, net: gross - recovered, manual: 0 },
    };
  };

  it("groups by a key, biggest net first, none for blank", () => {
    const rows = groupMistakes([mk("a", { category_id: "c1", gross: 100 }), mk("b", { category_id: "c1", gross: 50, recovered: 20 }), mk("c", { gross: 500 })], (m) => m.category_id);
    expect(rows).toEqual([
      { key: NONE, count: 1, gross: 500, claimed: 0, recovered: 0, net: 500 },
      { key: "c1", count: 2, gross: 150, claimed: 0, recovered: 20, net: 130 },
    ]);
  });

  it("shows each job's mistakes as a share of its value; no-job mistakes left out", () => {
    const rows = mistakesByJob([mk("a", { gross: 500 }), mk("b", { job_id: "j2", gross: 100 }), mk("c", { job_id: null })], new Map([["j1", 10000]]));
    expect(rows.map((r) => [r.key, r.net, r.pctOfValue])).toEqual([
      ["j1", 500, 5],
      ["j2", 100, null],
    ]);
  });

  it("finds what's still costing us with nothing claimed, oldest first", () => {
    const o = openItems([mk("b", { occurred_on: "2026-11-05" }), mk("a", { occurred_on: "2026-11-01" }), mk("c", { claimed: 50 }), mk("d", { status: "closed", gross: 0 })]);
    expect(o.unrecovered.map((m) => m.id)).toEqual(["a", "b"]);
    expect(o.notClosed.map((m) => m.id)).toEqual(["a", "c", "b"]);
    expect(o.unrecoveredTotal).toBe(200);
  });

  it("counts claimed-but-not-received for the Monday email", () => {
    expect(openRecoverable([{ recovery_claimed_ex_gst: 100, recovered_ex_gst: 40 }, { recovery_claimed_ex_gst: 10, recovered_ex_gst: 30 }, {}])).toBe(60);
    const d = summariseDigestMistakes(
      [
        { raised_at: "2026-11-24T00:00:00Z", status: "open", recovery_claimed_ex_gst: 100, recovered_ex_gst: null },
        { raised_at: "2026-10-01T00:00:00Z", status: "closed", recovery_claimed_ex_gst: null, recovered_ex_gst: null },
      ],
      new Date("2026-11-25T00:00:00Z")
    );
    expect(d).toEqual({ newThisWeek: 1, open: 1, openRecoverable: 100 });
  });

  it("puts a Mistakes line in the Monday email, and leaves it out when not switched on", () => {
    const base = {
      appUrl: "https://x",
      unallocated: { count: 0, total: 0, bills: [] },
      coverage: [],
      overdue: { count: 0, total: 0, top: [] },
      awaitingInvoice: { count: 0, oldest: [] },
    } as unknown as Parameters<typeof buildDigest>[0];
    const withM = buildDigest({ ...base, mistakes: { newThisWeek: 3, open: 5, openRecoverable: 1200 } });
    expect(withM.text).toContain("MISTAKES: 3 logged this week, 5 not closed, $1,200 claimed back and not yet received");
    expect(withM.html).toContain("Mistakes: 3 logged this week");
    expect(buildDigest(base).text).not.toContain("MISTAKES");
  });

  it("files a mistake with no job under its own company cost centre", () => {
    const r = mistakesByMonth({
      mistakes: [{ id: "x", job_id: null, occurred_on: "2026-11-02", amount_ex_gst: 90, cost_center_id: null, cost_centre_id: "transport" }],
      lineCentre: new Map(),
      centres: [{ id: "transport", name: "Transport" }],
      months: ["2026-11"],
    });
    expect(r.cells["2026-11"].transport).toEqual({ amount: 90, count: 1 });
  });
});
