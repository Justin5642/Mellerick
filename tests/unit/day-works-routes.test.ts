import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// The phone's Day Works routes (Stage 2): add, edit, delete a draft and the
// builder's sign-off, under /api/jobs/[id]/hire-entries.
//
// What matters, in order:
//   1. THE MONEY RULE (HANDOVER §2). These routes read the office-only rate
//      tables through the service role, and every write answers with the
//      tab. A technician's GET and POST answers must carry no money-named key
//      and no rate or amount value at any depth.
//   2. Writes go through the CALLER's client (RLS + 0108's trigger decide),
//      never the service role.
//   3. requireOnJob first; a signed entry is locked; fixed error sentences.

const requireOnJob = vi.fn();
vi.mock("@/lib/api/guards", () => ({ requireOnJob: (...a: unknown[]) => requireOnJob(...a) }));
vi.mock("@/lib/monitoring", () => ({ reportError: vi.fn() }));

const JOB = "11111111-1111-4111-8111-111111111111";
const BOBCAT = "22222222-2222-4222-8222-222222222222";
const PC18 = "33333333-3333-4333-8333-333333333333";
const FLOAT = "44444444-4444-4444-8444-444444444444";
const TRENCHER = "55555555-5555-4555-8555-555555555555";
const ENTRY = "66666666-6666-4666-8666-666666666666";
// In the register with no hire rate yet (0108's name match missed it).
const PC180 = "77777777-7777-4777-8777-777777777777";

// Rates chosen so each is recognisable by value in a payload.
const RATES = [115.37, 251.19, 471.13, 5.17, 203.47];

type Call = [string, unknown[]];
interface Query {
  client: "admin" | "caller";
  table: string;
  calls: Call[];
  single: boolean;
}
type Result = { data?: unknown; error?: unknown; count?: number | null };

const queries: Query[] = [];
const uploads: { path: string; bytes: unknown; opts: unknown }[] = [];
const removed: string[][] = [];
let uploadError: unknown = null;
let rows: Record<string, unknown>[] = [];
let attachmentRows: { entry_id: string; attachment_id: string }[] = [];
let insertError: unknown = null;

const arg = (q: Query, method: string, col: string) => q.calls.find(([m, a]) => m === method && a[0] === col)?.[1][1];
const method = (q: Query) => q.calls.find(([m]) => ["insert", "update", "delete"].includes(m))?.[0] ?? "select";

function resolveAdmin(q: Query): Result {
  switch (q.table) {
    case "equipment":
      return {
        data: [
          { id: BOBCAT, name: "Kubota SVL75", is_active: true, equipment_hire_options: [{ hire_type: "wet", hire_unit: "hour", rate: 115.37, cost_centre_id: "cc-wet", is_active: true }] },
          { id: PC18, name: "PC18", is_active: true, equipment_hire_options: [{ hire_type: "dry", hire_unit: "day", rate: 251.19, whole_days_only: true, is_active: true }] },
          { id: FLOAT, name: "Quad axle float", is_active: true, equipment_hire_options: [{ hire_type: "float", hire_unit: "move", rate: 0, float_base: 471.13, float_km_included: 30, float_per_km: 5.17, is_active: true }] },
          { id: PC180, name: "Komatsu PC180", is_active: true, category: "machinery", equipment_hire_options: [] },
          { id: "tool-1", name: "Concrete saw", is_active: true, category: "tool", equipment_hire_options: [] },
        ],
        error: null,
      };
    case "hire_attachments":
      return { data: [{ id: TRENCHER, name: "Trencher", day_rate: 203.47, is_active: true }], error: null };
    case "cost_centres":
      return { data: [{ id: "cc-wet", name: "Plant Wet Hire" }], error: null };
    case "hire_entry_attachments":
      return { data: [], error: null };
    case "equipment_hire_options": {
      const eq = arg(q, "eq", "equipment_id");
      const t = arg(q, "eq", "hire_type");
      const u = arg(q, "eq", "hire_unit");
      const known: Record<string, { hire_type: string; hire_unit: string; whole_days_only: boolean }> = {
        [BOBCAT]: { hire_type: "wet", hire_unit: "hour", whole_days_only: false },
        [PC18]: { hire_type: "dry", hire_unit: "day", whole_days_only: true },
        [FLOAT]: { hire_type: "float", hire_unit: "move", whole_days_only: false },
      };
      const o = known[eq as string];
      return { data: o && o.hire_type === t && o.hire_unit === u ? o : null, error: null };
    }
  }
  return { data: null, error: null };
}

function resolveCaller(q: Query): Result {
  if (q.table === "hire_entry_attachments") {
    const m = method(q);
    if (m === "insert") {
      const list = q.calls.find(([c]) => c === "insert")![1][0] as { entry_id: string; attachment_id: string }[];
      attachmentRows.push(...list);
    }
    if (m === "delete") {
      const ids = arg(q, "in", "attachment_id") as string[];
      attachmentRows = attachmentRows.filter((a) => !ids.includes(a.attachment_id));
    }
    return { error: null };
  }
  const id = arg(q, "eq", "id");
  const job = arg(q, "eq", "job_id");
  const status = arg(q, "eq", "status");
  const match = (r: Record<string, unknown>) => (id === undefined || r.id === id) && (job === undefined || r.job_id === job) && (status === undefined || r.status === status);
  switch (method(q)) {
    case "insert": {
      if (insertError) return { error: insertError };
      rows.push({ status: "draft", signer_name: null, signature_path: null, signed_at: null, invoice_id: null, void_reason: null, created_by: "tech-1", cost_centre_id: "cc-wet", created_at: "2026-11-16T00:00:00Z", ...(q.calls.find(([c]) => c === "insert")![1][0] as object) });
      return { error: null };
    }
    case "update": {
      const patch = q.calls.find(([c]) => c === "update")![1][0] as object;
      const hit = rows.filter(match);
      hit.forEach((r) => Object.assign(r, patch));
      return { error: null, count: hit.length };
    }
    case "delete": {
      const before = rows.length;
      rows = rows.filter((r) => !match(r));
      return { error: null, count: before - rows.length };
    }
  }
  const hit = rows.filter(match).map((r) => ({
    ...r,
    hire_entry_attachments: attachmentRows.filter((a) => a.entry_id === r.id).map((a) => ({ attachment_id: a.attachment_id })),
    profiles: { full_name: "Tess Tech" },
  }));
  return q.single ? { data: hit[0] ?? null, error: null } : { data: hit, error: null };
}

function fakeClient(client: "admin" | "caller") {
  return {
    from(table: string) {
      const q: Query = { client, table, calls: [], single: false };
      queries.push(q);
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "insert", "update", "delete", "eq", "neq", "in", "order", "limit"]) {
        chain[m] = (...a: unknown[]) => {
          q.calls.push([m, a]);
          return chain;
        };
      }
      const run = () => (client === "admin" ? resolveAdmin(q) : resolveCaller(q));
      chain.maybeSingle = async () => {
        q.single = true;
        return run();
      };
      chain.then = (ok: (v: Result) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad);
      return chain;
    },
    storage: {
      from: () => ({
        upload: async (path: string, bytes: unknown, opts: unknown) => {
          uploads.push({ path, bytes, opts });
          return { error: uploadError };
        },
        remove: async (paths: string[]) => {
          removed.push(paths);
          return { error: null };
        },
        createSignedUrls: async (paths: string[]) => ({ data: paths.map((p) => ({ path: p, signedUrl: `https://signed.example/${p}` })), error: null }),
      }),
    },
  };
}

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => fakeClient("admin") }));
vi.mock("@/lib/api/caller-client", () => ({ callerClient: async () => fakeClient("caller") }));

import { GET, POST } from "@/app/api/jobs/[id]/hire-entries/route";
import { PATCH, DELETE } from "@/app/api/jobs/[id]/hire-entries/[entryId]/route";
import { POST as SIGN } from "@/app/api/jobs/[id]/hire-entries/[entryId]/sign/route";

const ctx = { params: Promise.resolve({ id: JOB }) };
const entryCtx = (entryId = ENTRY) => ({ params: Promise.resolve({ id: JOB, entryId }) });
const req = (method: string, body?: unknown) =>
  new NextRequest(`http://test.local/api/jobs/${JOB}/hire-entries`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const asTech = () => requireOnJob.mockResolvedValue({ ok: true, userId: "tech-1", role: "technician" });
const asOffice = () => requireOnJob.mockResolvedValue({ ok: true, userId: "office-1", role: "office" });

const wetDay = { id: ENTRY, equipment_id: BOBCAT, hire_type: "wet", hire_unit: "hour", work_date: "2026-11-16", hours: 6.5, description: "Trenching", attachment_ids: [TRENCHER] };
const draftRow = (over: Record<string, unknown> = {}) => ({
  id: ENTRY,
  job_id: JOB,
  equipment_id: BOBCAT,
  hire_type: "wet",
  hire_unit: "hour",
  work_date: "2026-11-16",
  hours: "6.50",
  days: null,
  meter_open: null,
  meter_close: null,
  km: null,
  pickup: null,
  dropoff: null,
  description: "Trenching",
  cost_centre_id: "cc-wet",
  status: "draft",
  signer_name: null,
  signature_path: null,
  signed_at: null,
  invoice_id: null,
  void_reason: null,
  created_by: "tech-1",
  ...over,
});

// A minimal valid PNG (header + IHDR + IEND), base64.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const MONEY_KEY = /(rate|cost|price|amount|total|charge|fee|value|base|per_km|pricing|gst|margin)/i;
const NOT_MONEY = new Set(["cost_centre"]);
function moneyIn(v: unknown, path = "body", out = { keys: [] as string[], numbers: [] as number[] }) {
  if (Array.isArray(v)) v.forEach((x, i) => moneyIn(x, `${path}[${i}]`, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (MONEY_KEY.test(k) && !NOT_MONEY.has(k)) out.keys.push(`${path}.${k}`);
      moneyIn(x, `${path}.${k}`, out);
    }
  } else if (typeof v === "number") out.numbers.push(v);
  return out;
}
function expectNoMoney(body: unknown) {
  const out = moneyIn(body);
  expect(out.keys).toEqual([]);
  const amounts = [6.5 * 115.37, 6.5 * 115.37 + 203.47].map((n) => Math.round(n * 100) / 100);
  for (const r of [...RATES, ...amounts]) expect(out.numbers).not.toContain(r);
}
const writesBy = (client: "admin" | "caller") => queries.filter((q) => q.client === client && method(q) !== "select");

beforeEach(() => {
  vi.clearAllMocks();
  queries.length = 0;
  uploads.length = 0;
  removed.length = 0;
  uploadError = null;
  insertError = null;
  rows = [];
  attachmentRows = [];
});

describe("Day Works routes — the money rule", () => {
  it("a technician's POST answer carries no money key and no rate or amount", async () => {
    asTech();
    const res = await POST(req("POST", wetDay), ctx);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.saved).toEqual({ id: ENTRY });
    expect(body.entries).toHaveLength(1);
    expect(body.pricing).toBeUndefined();
    expectNoMoney(body);
  });

  it("a technician's GET answer carries no money key and no rate or amount", async () => {
    rows = [draftRow({ status: "signed", signer_name: "Sam", signature_path: `${JOB}/day-works/s.png` })];
    attachmentRows = [{ entry_id: ENTRY, attachment_id: TRENCHER }];
    asTech();
    const res = await GET(req("GET"), ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries[0].hours).toBe(6.5);
    expectNoMoney(body);
  });

  it("office gets the amounts (the same GET, so the check above is not vacuous)", async () => {
    rows = [draftRow()];
    attachmentRows = [{ entry_id: ENTRY, attachment_id: TRENCHER }];
    asOffice();
    const body = await (await GET(req("GET"), ctx)).json();
    expect(body.pricing.entries[ENTRY].total).toBe(Math.round((6.5 * 115.37 + 203.47) * 100) / 100);
    expect(moneyIn(body).keys.length).toBeGreaterThan(0);
  });
});

describe("POST /hire-entries — add a draft", () => {
  it("refuses a caller who isn't on the job before reading or writing anything", async () => {
    requireOnJob.mockResolvedValue({ ok: false, response: new Response("{}", { status: 403 }) });
    expect((await POST(req("POST", wetDay), ctx)).status).toBe(403);
    expect(queries).toHaveLength(0);
  });

  it("writes with the caller's client, never the service role, and ticks the attachments", async () => {
    asTech();
    await POST(req("POST", wetDay), ctx);
    expect(writesBy("admin")).toEqual([]);
    const insert = writesBy("caller").find((q) => q.table === "hire_entries")!;
    expect(insert.calls.find(([m]) => m === "insert")![1][0]).toMatchObject({ id: ENTRY, job_id: JOB, equipment_id: BOBCAT, hours: 6.5, days: null, km: null });
    expect(attachmentRows).toEqual([{ entry_id: ENTRY, attachment_id: TRENCHER }]);
  });

  it("answers a retry with the same id as saved, without adding it twice", async () => {
    rows = [draftRow()];
    asTech();
    const res = await POST(req("POST", wetDay), ctx);
    expect(res.status).toBe(200);
    expect(writesBy("caller")).toEqual([]);
    expect(rows).toHaveLength(1);
  });

  it("applies the web form's rules, in the web form's words", async () => {
    asTech();
    const cases: [unknown, RegExp][] = [
      [null, /entry's details/],
      [{ ...wetDay, equipment_id: "not-a-uuid" }, /Pick the machine/],
      [{ ...wetDay, hire_type: "dry", hire_unit: "day" }, /Pick the machine/], // not set up that way
      [{ ...wetDay, work_date: "2026-02-30" }, /Pick the date/],
      [{ ...wetDay, hours: -1 }, /Check the numbers/],
      [{ ...wetDay, hours: "lots" }, /Check the numbers/],
      [{ ...wetDay, hours: 25 }, /more than 24/],
      [{ ...wetDay, equipment_id: PC18, hire_type: "dry", hire_unit: "day", days: 1.5 }, /full days only/],
      [{ ...wetDay, equipment_id: FLOAT, hire_type: "float", hire_unit: "move", km: 40 }, /float move doesn't take attachments/],
    ];
    for (const [body, msg] of cases) {
      const res = await POST(req("POST", body), ctx);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(msg);
    }
    expect(writesBy("caller")).toEqual([]);
  });

  it("lists a machine with no hire rate (no options) but refuses a line for it", async () => {
    asTech();
    const body = await (await GET(req("GET"), ctx)).json();
    expect(body.machines.find((m: { id: string }) => m.id === PC180)).toEqual({ id: PC180, name: "Komatsu PC180", options: [] });
    expect(body.machines.some((m: { name: string }) => m.name === "Concrete saw")).toBe(false);
    for (const [t, u] of [["wet", "hour"], ["dry", "day"]]) {
      const res = await POST(req("POST", { ...wetDay, equipment_id: PC180, hire_type: t, hire_unit: u, days: 1, attachment_ids: [] }), ctx);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/not set up for this kind of hire|Pick the machine/);
    }
    expect(writesBy("caller")).toEqual([]);
  });

  it("keeps float pick-up, drop-off and km", async () => {
    asTech();
    const res = await POST(req("POST", { equipment_id: FLOAT, hire_type: "float", hire_unit: "move", work_date: "2026-11-16", km: "52", pickup: "Depot", dropoff: "Lot 12", hours: 3 }), ctx);
    expect(res.status).toBe(201);
    expect(rows[0]).toMatchObject({ km: 52, pickup: "Depot", dropoff: "Lot 12", hours: null });
  });

  it("turns a duplicate machine-day into a fixed sentence", async () => {
    insertError = { code: "23505", message: 'duplicate key value violates unique constraint "hire_entries_one_per_machine_day"' };
    asTech();
    const res = await POST(req("POST", wetDay), ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/already has a Day Works line/);
    expect(body.error).not.toMatch(/constraint/);
  });
});

describe("PATCH / DELETE /hire-entries/[entryId] — drafts only", () => {
  it("edits a draft's quantities and attachments through the caller's client", async () => {
    rows = [draftRow()];
    attachmentRows = [{ entry_id: ENTRY, attachment_id: TRENCHER }];
    asTech();
    const res = await PATCH(req("PATCH", { ...wetDay, hours: 8, attachment_ids: [] }), entryCtx());
    expect(res.status).toBe(200);
    expect(rows[0].hours).toBe(8);
    expect(attachmentRows).toEqual([]);
    expect(writesBy("admin")).toEqual([]);
    expectNoMoney(await res.json());
  });

  it("refuses to edit a signed entry — it is locked", async () => {
    rows = [draftRow({ status: "signed", signer_name: "Sam", signature_path: "x.png" })];
    asTech();
    const res = await PATCH(req("PATCH", { ...wetDay, hours: 8 }), entryCtx());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/signed and locked/);
    expect(writesBy("caller")).toEqual([]);
  });

  it("404s an entry from another job", async () => {
    rows = [draftRow({ job_id: "another-job" })];
    asTech();
    expect((await PATCH(req("PATCH", wetDay), entryCtx())).status).toBe(404);
  });

  it("deletes a draft, and refuses a signed one", async () => {
    rows = [draftRow()];
    asTech();
    expect((await DELETE(req("DELETE"), entryCtx())).status).toBe(200);
    expect(rows).toEqual([]);
    rows = [draftRow({ status: "signed" })];
    const res = await DELETE(req("DELETE"), entryCtx());
    expect(res.status).toBe(409);
    expect(rows).toHaveLength(1);
  });
});

describe("POST /hire-entries/[entryId]/sign — the builder's sign-off", () => {
  it("uploads the signature where the web puts it, then signs the entry with the caller's client", async () => {
    rows = [draftRow()];
    asTech();
    const res = await SIGN(req("POST", { signer_name: " Sam Builder ", signature: `data:image/png;base64,${PNG_B64}` }), entryCtx());
    expect(res.status).toBe(200);
    expect(uploads).toHaveLength(1);
    expect(uploads[0].path).toMatch(new RegExp(`^${JOB}/day-works/signature-${ENTRY}-\\d+\\.png$`));
    expect(uploads[0].opts).toEqual({ contentType: "image/png" });
    expect(rows[0]).toMatchObject({ status: "signed", signer_name: "Sam Builder", signature_path: uploads[0].path });
    expect(writesBy("admin")).toEqual([]);
    const body = await res.json();
    expect(body.entries[0].status).toBe("signed");
    expectNoMoney(body);
  });

  it("needs a name and a real PNG signature", async () => {
    rows = [draftRow()];
    asTech();
    expect((await SIGN(req("POST", { signer_name: "", signature: PNG_B64 }), entryCtx())).status).toBe(400);
    expect((await SIGN(req("POST", { signer_name: "Sam", signature: "aGVsbG8=" }), entryCtx())).status).toBe(400);
    expect(uploads).toEqual([]);
  });

  it("won't sign without the quantity, and uploads nothing", async () => {
    rows = [draftRow({ hours: null })];
    asTech();
    const res = await SIGN(req("POST", { signer_name: "Sam", signature: PNG_B64 }), entryCtx());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Enter the hours/);
    expect(uploads).toEqual([]);
  });

  it("answers a retry by the same signer as signed; refuses anyone else", async () => {
    rows = [draftRow({ status: "signed", signer_name: "Sam", signature_path: "x.png" })];
    asTech();
    expect((await SIGN(req("POST", { signer_name: "Sam", signature: PNG_B64 }), entryCtx())).status).toBe(200);
    expect((await SIGN(req("POST", { signer_name: "Someone else", signature: PNG_B64 }), entryCtx())).status).toBe(409);
    expect(uploads).toEqual([]);
  });

  it("says so, in a fixed sentence, when the upload fails — and leaves the entry a draft", async () => {
    rows = [draftRow()];
    uploadError = { message: "new row violates row-level security policy for table objects" };
    asTech();
    const res = await SIGN(req("POST", { signer_name: "Sam", signature: PNG_B64 }), entryCtx());
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/didn't upload/);
    expect(rows[0].status).toBe("draft");
  });
});
