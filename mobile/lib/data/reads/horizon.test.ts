// The sync window: once old rows stop syncing (draft migration 0068, not yet
// applied), a local read must never present a truncated answer as complete.
// These tests drive the real read functions through a fake mirror that HAS a
// horizon row, and assert which source answered.
//
// The supabase mock records every table it is asked for, so "went to the
// network" is observable, and answers with a sentinel row so the remote result
// is distinguishable from a local one.
const remoteTables: string[] = [];
jest.mock("../../supabase", () => {
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "in", "is", "not", "or", "gte", "lt", "lte", "order", "range", "limit", "single"]) {
    builder[m] = jest.fn(() => builder);
  }
  (builder as { then?: unknown }).then = (resolve: (v: unknown) => unknown) =>
    resolve({ data: [], error: null, count: 0 });
  return {
    supabase: {
      from: jest.fn((table: string) => {
        remoteTables.push(table);
        return builder;
      }),
    },
  };
});

import {
  OutsideSyncWindow,
  fromLocalOr,
  onReadOrigin,
  resetSourceForTests,
  setLocalReads,
  type LocalReads,
  type ReadOriginReason,
} from "./source";
import {
  SQL_JOB_ON_DEVICE,
  SQL_SYNC_HORIZON,
  requireCompletePage,
  requireCoveredSince,
  timestampMs,
  windowCutoff,
} from "./horizon";
import { listInvoices, getInvoice, getInvoiceJobPrefill } from "./finance";
import { getCustomerOverview } from "./customers";
import { getReportSummary, getReportAnalytics, getEquipmentUtilization } from "./reports";
import { listOfficeJobs, searchJobs, listMyJobs } from "./jobs";
import { getJobBilling } from "./jobBilling";
import { listEquipmentUsage } from "./fleet";
import { countOtherScheduledJobs } from "./schedule";

const norm = (sql: string) => sql.replace(/\s+/g, " ").trim();

// PowerSync renders timestamptz like this; the cutoff is 2024-10-09.
const HORIZON = {
  tech_cutoff: "2026-07-11 16:17:00.123456Z",
  office_cutoff: "2024-10-09 16:17:00.123456Z",
  backflow_cutoff: "2024-10-09 16:17:00.123456Z",
};

/**
 * A mirror that answers the horizon probe with `horizon` and every other
 * statement from `rows` (keyed by a substring of the SQL), default empty.
 */
function mirror(horizon: object | null, rows: Array<[string, unknown[]]> = [], one: Array<[string, unknown]> = []) {
  const pick = (sql: string) => rows.find(([k]) => norm(sql).includes(k))?.[1] ?? [];
  const db: LocalReads = {
    hasSynced: () => true,
    role: () => "office",
    getAll: jest.fn(async (sql: string) => pick(sql)) as LocalReads["getAll"],
    getOptional: jest.fn(async (sql: string) => {
      if (norm(sql) === norm(SQL_SYNC_HORIZON)) return horizon;
      return one.find(([k]) => norm(sql).includes(k))?.[1] ?? null;
    }) as LocalReads["getOptional"],
  };
  setLocalReads(db);
  return db;
}

let reasons: (ReadOriginReason | undefined)[] = [];
beforeEach(() => {
  remoteTables.length = 0;
  reasons = [];
  onReadOrigin((_o, r) => reasons.push(r));
});
afterEach(() => {
  resetSourceForTests();
  jest.clearAllMocks();
});

describe("timestampMs", () => {
  it("parses PowerSync, PostgREST and date-only renderings to the same instant", () => {
    const t = Date.UTC(2024, 9, 9, 16, 17, 0, 123);
    expect(timestampMs("2024-10-09 16:17:00.123456Z")).toBe(t);
    expect(timestampMs("2024-10-09T16:17:00.123+00:00")).toBe(t);
    expect(timestampMs("2024-10-10T03:17:00.123+11:00")).toBe(t);
    expect(timestampMs("2024-10-09")).toBe(Date.UTC(2024, 9, 9));
  });

  it("returns NaN rather than guessing", () => {
    expect(timestampMs("yesterday")).toBeNaN();
    expect(timestampMs(null)).toBeNaN();
  });
});

describe("windowCutoff", () => {
  it("is null with no horizon row — the pre-window behaviour, every row synced", async () => {
    expect(await windowCutoff(mirror(null), "office")).toBeNull();
  });

  it("is null for a row that is not a horizon row (shared London-school fakes)", async () => {
    expect(await windowCutoff(mirror({ id: "job-1", title: "x" }), "office")).toBeNull();
  });

  it("reads the scope's own cutoff", async () => {
    expect(await windowCutoff(mirror(HORIZON), "office")).toBe(timestampMs(HORIZON.office_cutoff));
    expect(await windowCutoff(mirror(HORIZON), "tech")).toBe(timestampMs(HORIZON.tech_cutoff));
  });

  it("refuses a horizon row it cannot read (window in force, extent unknown)", async () => {
    await expect(windowCutoff(mirror({ ...HORIZON, office_cutoff: "garbage" }), "office")).rejects.toBeInstanceOf(
      OutsideSyncWindow
    );
  });
});

describe("requireCompletePage", () => {
  const db = () => mirror(HORIZON);
  const row = (created_at: string) => ({ created_at });

  it("accepts a full page whose oldest row is inside the window", async () => {
    await expect(
      requireCompletePage(db(), "office", [row("2026-01-01 00:00:00Z"), row("2025-01-01 00:00:00Z")], 2, "t")
    ).resolves.toBeUndefined();
  });

  it("rejects a short page — older matches may exist only on the server", async () => {
    await expect(requireCompletePage(db(), "office", [row("2026-01-01 00:00:00Z")], 2, "t")).rejects.toBeInstanceOf(
      OutsideSyncWindow
    );
  });

  it("rejects a full page that reaches past the cutoff", async () => {
    await expect(
      requireCompletePage(db(), "office", [row("2026-01-01 00:00:00Z"), row("2023-01-01 00:00:00Z")], 2, "t")
    ).rejects.toBeInstanceOf(OutsideSyncWindow);
  });

  it("accepts anything when no window is in force (negative control)", async () => {
    await expect(requireCompletePage(mirror(null), "office", [], 25, "t")).resolves.toBeUndefined();
  });
});

describe("requireCoveredSince", () => {
  it("accepts a bound inside the window and rejects one before it", async () => {
    await expect(requireCoveredSince(mirror(HORIZON), "office", "2025-06-01", "t")).resolves.toBeUndefined();
    await expect(requireCoveredSince(mirror(HORIZON), "office", "2024-06-01", "t")).rejects.toBeInstanceOf(
      OutsideSyncWindow
    );
  });
});

describe("fromLocalOr routes OutsideSyncWindow to the network under its own reason", () => {
  it("emits out-of-window, not local-threw", async () => {
    mirror(HORIZON);
    const remote = jest.fn().mockResolvedValue("remote");
    const result = await fromLocalOr(async () => {
      throw new OutsideSyncWindow("test");
    }, remote);
    expect(result).toBe("remote");
    expect(reasons).toEqual(["out-of-window"]);
  });
});

// ---------------------------------------------------------------------------
// The reads themselves. Each pair: windowed → network; no window → local, so
// the guard cannot decay into "always go to the network".
// ---------------------------------------------------------------------------
describe("paged lists", () => {
  const invoice = (id: string, created_at: string) => ({
    id, invoice_number: 1, title: "t", total: 1, status: "sent", due_date: null, created_at, customer_name: null,
  });

  it("listInvoices answers locally when the page is full and inside the window", async () => {
    mirror(HORIZON, [["FROM invoices i", [invoice("a", "2026-09-01 00:00:00Z"), invoice("b", "2025-09-01 00:00:00Z")]]]);
    const rows = await listInvoices(0, 2);
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(remoteTables).toEqual([]);
  });

  it("listInvoices goes to Supabase for the page that runs past the window", async () => {
    mirror(HORIZON, [["FROM invoices i", [invoice("a", "2026-09-01 00:00:00Z")]]]);
    await listInvoices(25, 25);
    expect(remoteTables).toEqual(["invoices"]);
    expect(reasons).toEqual(["out-of-window"]);
  });

  it("listOfficeJobs: short page → network", async () => {
    mirror(HORIZON, [["FROM jobs j", [{ id: "j", job_number: 1, title: "t", status: "completed", priority: "low", created_at: "2026-01-01 00:00:00Z" }]]]);
    await listOfficeJobs(0, 25);
    expect(remoteTables).toEqual(["jobs"]);
  });

  it("searchJobs: fewer than 50 local matches may hide older ones → network", async () => {
    mirror(HORIZON, [["FROM jobs j", []]]);
    await searchJobs("smith");
    expect(remoteTables).toEqual(["jobs"]);
  });

  it("listMyJobs stays local under a window — open jobs are always synced", async () => {
    mirror(HORIZON);
    await listMyJobs("tech-1");
    expect(remoteTables).toEqual([]);
  });
});

describe("all-history reads", () => {
  it("getCustomerOverview: network when windowed, local when not", async () => {
    mirror(HORIZON);
    await getCustomerOverview("c1");
    expect(remoteTables.sort()).toEqual(["invoices", "jobs", "quotes"]);

    remoteTables.length = 0;
    mirror(null);
    await getCustomerOverview("c1");
    expect(remoteTables).toEqual([]);
  });

  it("getReportSummary and getReportAnalytics: network when windowed", async () => {
    mirror(HORIZON);
    await getReportSummary();
    await getReportAnalytics();
    expect(remoteTables).toContain("invoices");
    expect(reasons).toEqual(["out-of-window", "out-of-window"]);
  });

  it("listEquipmentUsage: network when windowed, local when not", async () => {
    mirror(HORIZON);
    await listEquipmentUsage("e1");
    expect(remoteTables).toEqual(["equipment_usage_log"]);

    remoteTables.length = 0;
    mirror(null);
    await listEquipmentUsage("e1");
    expect(remoteTables).toEqual([]);
  });

  it("getEquipmentUtilization (12 months) stays local inside a 24-month window", async () => {
    mirror(HORIZON);
    await getEquipmentUtilization();
    expect(remoteTables).toEqual([]);
  });

  it("countOtherScheduledJobs: local for a day inside the window, network before it", async () => {
    mirror(HORIZON, [], [["COUNT(*) AS n FROM jobs", { n: 2 }]]);
    await expect(countOtherScheduledJobs("t1", "2026-10-10", "j1")).resolves.toBe(2);
    expect(remoteTables).toEqual([]);

    await countOtherScheduledJobs("t1", "2023-10-10", "j1");
    expect(remoteTables).toEqual(["jobs"]);
  });
});

describe("by-id reads", () => {
  it("getInvoice: a local miss asks the server (may be older than the window)", async () => {
    mirror(HORIZON);
    await getInvoice("inv-old");
    expect(remoteTables).toEqual(["invoices"]);
  });

  it("getJobBilling: job not on the device → network; on the device → local", async () => {
    mirror(HORIZON);
    await getJobBilling("j-old");
    expect(remoteTables).toContain("jobs");

    remoteTables.length = 0;
    const db = mirror(HORIZON, [], [
      [norm(SQL_JOB_ON_DEVICE), { id: "j-new" }],
      ["SELECT job_number, title FROM jobs", { job_number: 7, title: "t" }],
    ]);
    const billing = await getJobBilling("j-new");
    expect(remoteTables).toEqual([]);
    expect(billing?.jobTitle).toBe("t");
    expect((db.getOptional as jest.Mock).mock.calls.map(([sql]) => norm(sql))).toContain(norm(SQL_JOB_ON_DEVICE));
  });

  it("getInvoiceJobPrefill: job not on the device → network", async () => {
    mirror(HORIZON);
    await getInvoiceJobPrefill("j-old");
    expect(remoteTables).toContain("jobs");
  });
});
