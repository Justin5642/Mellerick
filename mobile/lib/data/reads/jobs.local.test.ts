// London-school tests for the local (PowerSync) path of reads/jobs: a fake
// LocalReads is injected through the seam, fed SQLite-shaped rows, and the
// output must equal the PostgREST-shaped interfaces the job screens consume.
// The SQL text and bind params the fake receives are asserted on normalized
// whitespace. Also pinned here: the getJob "a local miss is not proof of
// absence" rule (null locally → answer from Supabase) and the office role
// gate (a technician is routed remote, never served a partial local list).
//
// The supabase client is mocked with a self-returning, thenable builder so
// remote paths resolve to "no rows" without touching the network — same
// isolation pattern as customers.local.test.ts.
jest.mock("../../supabase", () => {
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "not", "or", "order", "range", "limit", "single"]) {
    builder[m] = jest.fn(() => builder);
  }
  // Awaiting the builder (or any chained call) yields "no rows".
  (builder as { then?: unknown }).then = (resolve: (v: unknown) => unknown) => resolve({ data: null });
  return { supabase: { from: jest.fn(() => builder) } };
});

import { supabase } from "../../supabase";
import { resetSourceForTests, setLocalReads, type LocalReads, type LocalRole } from "./source";
import { getJob, listMyJobs, listOfficeJobs, searchJobs, searchOfficeJobs } from "./jobs";

/** Whitespace-normalize SQL for comparison. */
function norm(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function fakeReads(over: Partial<LocalReads> = {}): LocalReads {
  return {
    hasSynced: () => true,
    role: () => "office" as LocalRole,
    getAll: jest.fn().mockResolvedValue([]),
    getOptional: jest.fn().mockResolvedValue(null),
    ...over,
  };
}

afterEach(() => {
  resetSourceForTests();
  jest.clearAllMocks();
});

describe("listMyJobs (local)", () => {
  const sqliteRows = [
    {
      id: "j1", job_number: 101, title: "Backflow annual test", status: "scheduled",
      scheduled_start: "2026-07-27T08:00:00+00:00", scheduled_end: "2026-07-27T10:00:00+00:00",
      customer_name: "Acme Pty Ltd",
      site_name: "Head office", site_address_line1: "1 Main St", site_suburb: "Richmond",
      site_lat: -37.82, site_lng: 144.99,
    },
    {
      id: "j2", job_number: 102, title: "Pump repair", status: "pending",
      scheduled_start: null, scheduled_end: null,
      customer_name: null,
      site_name: null, site_address_line1: null, site_suburb: null,
      site_lat: null, site_lng: null,
    },
  ];

  it("maps SQLite rows to the PostgREST shape (null FK → null embed, not {name: null})", async () => {
    const getAll = jest.fn().mockResolvedValue(sqliteRows);
    setLocalReads(fakeReads({ getAll }));

    const rows = await listMyJobs("user-1");

    expect(rows).toEqual([
      {
        id: "j1", job_number: 101, title: "Backflow annual test", status: "scheduled",
        scheduled_start: "2026-07-27T08:00:00+00:00", scheduled_end: "2026-07-27T10:00:00+00:00",
        customers: { name: "Acme Pty Ltd" },
        sites: { name: "Head office", address_line1: "1 Main St", suburb: "Richmond", site_lat: -37.82, site_lng: 144.99 },
      },
      {
        id: "j2", job_number: 102, title: "Pump repair", status: "pending",
        scheduled_start: null, scheduled_end: null,
        customers: null,
        sites: null,
      },
    ]);
    expect(getAll).toHaveBeenCalledTimes(1);
    const [sql, params] = getAll.mock.calls[0];
    expect(norm(sql)).toBe(norm(`
      SELECT j.id, j.job_number, j.title, j.status, j.scheduled_start, j.scheduled_end,
             c.name AS customer_name,
             s.name AS site_name, s.address_line1 AS site_address_line1,
             s.suburb AS site_suburb, s.site_lat, s.site_lng
      FROM jobs j
      LEFT JOIN customers c ON c.id = j.customer_id
      LEFT JOIN sites     s ON s.id = j.site_id
      WHERE j.assigned_to = ?
        AND j.status NOT IN ('completed', 'cancelled')
      ORDER BY j.scheduled_start IS NULL, j.scheduled_start`));
    expect(params).toEqual(["user-1"]);
    expect(supabase.from as jest.Mock).not.toHaveBeenCalled();
  });

  it("has NO role gate — a technician's scoped mirror is served locally", async () => {
    const getAll = jest.fn().mockResolvedValue([]);
    setLocalReads(fakeReads({ role: () => "technician", getAll }));

    await expect(listMyJobs("tech-1")).resolves.toEqual([]);
    expect(getAll).toHaveBeenCalledTimes(1);
    expect(supabase.from as jest.Mock).not.toHaveBeenCalled();
  });
});

describe("getJob (local)", () => {
  const sqliteRow = {
    id: "j1", job_number: 101, title: "Backflow annual test", status: "in_progress",
    priority: "high", description: "Annual RPZ test", notes: "Bring spare kit",
    job_type: "maintenance", created_at: "2026-07-01T00:00:00+00:00",
    scheduled_start: "2026-07-27T08:00:00+00:00", scheduled_end: "2026-07-27T10:00:00+00:00",
    actual_start: "2026-07-27T08:05:00+00:00", actual_end: null,
    completion_notes: null, overtime_reason: null, overtime_category: null,
    voice_report_transcript: null,
    customer_name: "Acme Pty Ltd", customer_phone: "03 9000 0000",
    customer_mobile: null, customer_email: "acme@example.com",
    site_name: "Head office", site_address_line1: "1 Main St", site_suburb: "Richmond",
    site_state: "VIC", site_postcode: "3121", site_lat: -37.82, site_lng: 144.99,
  };

  it("assembles the detail with customer/site embeds from the LEFT JOIN aliases", async () => {
    const getOptional = jest.fn().mockResolvedValue(sqliteRow);
    setLocalReads(fakeReads({ getOptional }));

    const job = await getJob("j1");

    expect(job).toEqual({
      id: "j1", job_number: 101, title: "Backflow annual test", status: "in_progress",
      priority: "high", description: "Annual RPZ test", notes: "Bring spare kit",
      job_type: "maintenance", created_at: "2026-07-01T00:00:00+00:00",
      scheduled_start: "2026-07-27T08:00:00+00:00", scheduled_end: "2026-07-27T10:00:00+00:00",
      actual_start: "2026-07-27T08:05:00+00:00", actual_end: null,
      completion_notes: null, overtime_reason: null, overtime_category: null,
      voice_report_transcript: null,
      customers: { name: "Acme Pty Ltd", phone: "03 9000 0000", mobile: null, email: "acme@example.com" },
      sites: { name: "Head office", address_line1: "1 Main St", suburb: "Richmond", state: "VIC", postcode: "3121", site_lat: -37.82, site_lng: 144.99 },
    });
    const [sql, params] = getOptional.mock.calls[0];
    expect(norm(sql)).toBe(norm(`
      SELECT j.id, j.job_number, j.title, j.status, j.priority, j.description, j.notes,
             j.job_type, j.created_at, j.scheduled_start, j.scheduled_end,
             j.actual_start, j.actual_end, j.completion_notes,
             j.overtime_reason, j.overtime_category, j.voice_report_transcript,
             c.name AS customer_name, c.phone AS customer_phone,
             c.mobile AS customer_mobile, c.email AS customer_email,
             s.name AS site_name, s.address_line1 AS site_address_line1,
             s.suburb AS site_suburb, s.state AS site_state, s.postcode AS site_postcode,
             s.site_lat, s.site_lng
      FROM jobs j
      LEFT JOIN customers c ON c.id = j.customer_id
      LEFT JOIN sites     s ON s.id = j.site_id
      WHERE j.id = ?`));
    expect(params).toEqual(["j1"]);
    // A local hit never touches the network.
    expect(supabase.from as jest.Mock).not.toHaveBeenCalled();
  });

  it("is served locally for a technician too — no role gate on the shared route", async () => {
    const getOptional = jest.fn().mockResolvedValue(sqliteRow);
    setLocalReads(fakeReads({ role: () => "technician", getOptional }));

    const job = await getJob("j1");

    expect(job?.id).toBe("j1");
    expect(getOptional).toHaveBeenCalledTimes(1);
    expect(supabase.from as jest.Mock).not.toHaveBeenCalled();
  });

  it("falls back to Supabase on a local MISS — locally absent is not proof of absence", async () => {
    // A technician opening a job NOT assigned to them: their mirror has no
    // row, but the server (RLS permitting) returns it. Local null must NOT
    // be surfaced as "Job not found".
    const getOptional = jest.fn().mockResolvedValue(null);
    setLocalReads(fakeReads({ role: () => "technician", getOptional }));

    const job = await getJob("someone-elses-job");

    // The local path was attempted, missed, and the Supabase body ran (the
    // mocked builder yields no rows, so the final answer here is null).
    expect(getOptional).toHaveBeenCalledTimes(1);
    expect(supabase.from as jest.Mock).toHaveBeenCalledWith("jobs");
    expect(job).toBeNull();
  });
});

describe("listOfficeJobs (local)", () => {
  const sqliteRows = [
    { id: "j1", job_number: 101, title: "Backflow annual test", status: "scheduled", priority: "normal", customer_name: "Acme Pty Ltd", assigned_profile_full_name: "Terry Tech" },
    { id: "j2", job_number: 102, title: "Unassigned quote visit", status: "pending", priority: "low", customer_name: null, assigned_profile_full_name: null },
  ];

  it("maps rows and paginates with LIMIT/OFFSET parity to .range()", async () => {
    const getAll = jest.fn().mockResolvedValue(sqliteRows);
    setLocalReads(fakeReads({ getAll }));

    const rows = await listOfficeJobs(50, 50);

    expect(rows).toEqual([
      { id: "j1", job_number: 101, title: "Backflow annual test", status: "scheduled", priority: "normal", customers: { name: "Acme Pty Ltd" }, assigned_profile: { full_name: "Terry Tech" } },
      { id: "j2", job_number: 102, title: "Unassigned quote visit", status: "pending", priority: "low", customers: null, assigned_profile: null },
    ]);
    const [sql, params] = getAll.mock.calls[0];
    expect(norm(sql)).toBe(norm(`
      SELECT j.id, j.job_number, j.title, j.status, j.priority,
             c.name AS customer_name,
             p.full_name AS assigned_profile_full_name
      FROM jobs j
      LEFT JOIN customers c ON c.id = j.customer_id
      LEFT JOIN profiles  p ON p.id = j.assigned_to
      ORDER BY j.created_at DESC, j.id DESC
      LIMIT ? OFFSET ?`));
    // .range(50, 99) ⇄ LIMIT 50 OFFSET 50.
    expect(params).toEqual([50, 50]);
  });
});

describe("searchOfficeJobs (local)", () => {
  it("binds a stripped text query as ?1 with no numeric fallback", async () => {
    const getAll = jest.fn().mockResolvedValue([]);
    setLocalReads(fakeReads({ getAll }));

    await searchOfficeJobs("pump, (urgent)%", 50);

    const [sql, params] = getAll.mock.calls[0];
    expect(norm(sql)).toBe(norm(`
      SELECT j.id, j.job_number, j.title, j.status, j.priority,
             c.name AS customer_name,
             p.full_name AS assigned_profile_full_name
      FROM jobs j
      LEFT JOIN customers c ON c.id = j.customer_id
      LEFT JOIN profiles  p ON p.id = j.assigned_to
      WHERE (?1 IS NULL OR j.title LIKE '%'||?1||'%' OR (?2 IS NOT NULL AND j.job_number = ?2))
      ORDER BY j.created_at DESC, j.id DESC
      LIMIT ?`));
    // Same [,()%]-strip as the Supabase path (each stripped char becomes a
    // space, then trim); not all-digits → ?2 is NULL.
    expect(params).toEqual(["pump   urgent", null, 50]);
  });

  it("binds an all-digits query as BOTH title substring and exact job number", async () => {
    const getAll = jest.fn().mockResolvedValue([]);
    setLocalReads(fakeReads({ getAll }));

    await searchOfficeJobs("101", 50);

    const [, params] = getAll.mock.calls[0];
    expect(params).toEqual(["101", 101, 50]);
  });

  it("binds NULLs for an empty query — first page, unfiltered (runSearch parity)", async () => {
    const getAll = jest.fn().mockResolvedValue([]);
    setLocalReads(fakeReads({ getAll }));

    await searchOfficeJobs("  ", 50);

    const [, params] = getAll.mock.calls[0];
    expect(params).toEqual([null, null, 50]);
  });
});

describe("searchJobs (local)", () => {
  const sqliteRows = [
    {
      id: "j1", job_number: 101, title: "Backflow annual test", status: "completed",
      scheduled_start: "2026-06-01T08:00:00+00:00",
      customer_name: "Acme Pty Ltd",
      site_name: "Head office", site_address_line1: "1 Main St", site_suburb: "Richmond",
      site_lat: -37.82, site_lng: 144.99,
    },
    {
      id: "j2", job_number: 102, title: "Old pump job", status: "cancelled",
      scheduled_start: null,
      customer_name: null,
      site_name: null, site_address_line1: null, site_suburb: null,
      site_lat: null, site_lng: null,
    },
  ];

  it("returns [] for an empty query without touching local OR remote (screen parity)", async () => {
    const getAll = jest.fn();
    setLocalReads(fakeReads({ getAll }));

    await expect(searchJobs("   ")).resolves.toEqual([]);
    expect(getAll).not.toHaveBeenCalled();
    expect(supabase.from as jest.Mock).not.toHaveBeenCalled();
  });

  it("serves an office mirror via SQL LIKE over the screen's haystack fields", async () => {
    const getAll = jest.fn().mockResolvedValue(sqliteRows);
    setLocalReads(fakeReads({ getAll }));

    const rows = await searchJobs("main st");

    expect(rows).toEqual([
      {
        id: "j1", job_number: 101, title: "Backflow annual test", status: "completed",
        scheduled_start: "2026-06-01T08:00:00+00:00",
        customers: { name: "Acme Pty Ltd" },
        sites: { name: "Head office", address_line1: "1 Main St", suburb: "Richmond", site_lat: -37.82, site_lng: 144.99 },
      },
      {
        id: "j2", job_number: 102, title: "Old pump job", status: "cancelled",
        scheduled_start: null,
        customers: null,
        sites: null,
      },
    ]);
    const [sql, params] = getAll.mock.calls[0];
    expect(norm(sql)).toBe(norm(`
      SELECT j.id, j.job_number, j.title, j.status, j.scheduled_start,
             c.name AS customer_name,
             s.name AS site_name, s.address_line1 AS site_address_line1,
             s.suburb AS site_suburb, s.site_lat, s.site_lng
      FROM jobs j
      LEFT JOIN customers c ON c.id = j.customer_id
      LEFT JOIN sites     s ON s.id = j.site_id
      WHERE CAST(j.job_number AS TEXT) LIKE '%'||?1||'%' ESCAPE '\\'
         OR j.title LIKE '%'||?1||'%' ESCAPE '\\'
         OR c.name LIKE '%'||?1||'%' ESCAPE '\\'
         OR s.name LIKE '%'||?1||'%' ESCAPE '\\'
         OR s.address_line1 LIKE '%'||?1||'%' ESCAPE '\\'
         OR s.suburb LIKE '%'||?1||'%' ESCAPE '\\'
      ORDER BY j.created_at DESC
      LIMIT 50`));
    expect(params).toEqual(["main st"]);
  });

  it("escapes LIKE metacharacters so the bound query matches as a plain substring", async () => {
    const getAll = jest.fn().mockResolvedValue([]);
    setLocalReads(fakeReads({ getAll }));

    await searchJobs("50%_off\\");

    const [, params] = getAll.mock.calls[0];
    expect(params).toEqual(["50\\%\\_off\\\\"]);
  });

  it("routes a TECHNICIAN remote — their mirror holds only their own jobs, and this screen searches ALL jobs", async () => {
    const getAll = jest.fn();
    setLocalReads(fakeReads({ role: () => "technician", getAll }));

    await expect(searchJobs("anything")).resolves.toEqual([]);
    expect(getAll).not.toHaveBeenCalled();
    expect(supabase.from as jest.Mock).toHaveBeenCalledWith("jobs");
  });
});

describe("office role gate", () => {
  it("never touches the local DB for a technician on the office reads — the remote (RLS-guarded) path is taken", async () => {
    const getAll = jest.fn();
    const getOptional = jest.fn();
    setLocalReads(fakeReads({ role: () => "technician", getAll, getOptional }));

    await listOfficeJobs(0, 50);
    await searchOfficeJobs("pump", 50);

    expect(getAll).not.toHaveBeenCalled();
    expect(getOptional).not.toHaveBeenCalled();
    // The Supabase client was exercised instead.
    expect((supabase.from as jest.Mock).mock.calls.length).toBeGreaterThan(0);
  });
});
