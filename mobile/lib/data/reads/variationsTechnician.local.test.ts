// Technician variations + the variation-type picker, local-first. Two rules:
// local and remote return IDENTICAL shapes, and NO money column is named or
// returned on either path (HANDOVER §2 — technicians never see a dollar figure).
const mockCalls: { table: string; chain: [string, unknown[]][] }[] = [];
const mockResponses: Record<string, unknown> = {};
jest.mock("../../supabase", () => ({
  supabase: {
    from: (table: string) => {
      const entry = { table, chain: [] as [string, unknown[]][] };
      mockCalls.push(entry);
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order"]) {
        builder[m] = (...args: unknown[]) => {
          entry.chain.push([m, args]);
          return builder;
        };
      }
      builder.then = (resolve: (v: unknown) => unknown) => resolve(mockResponses[table] ?? { data: [], error: null });
      return builder;
    },
  },
}));

import { resetSourceForTests, setLocalReads, type LocalReads, type LocalRole } from "./source";
import {
  listActiveVariationTypes,
  listJobVariationsForTechnician,
  SQL_ACTIVE_VARIATION_TYPES,
  SQL_JOB_IN_MIRROR_FOR_VARIATIONS,
  SQL_TECH_JOB_VARIATIONS,
  type TechnicianVariation,
  type VariationTypeOption,
} from "./variations";

const MONEY = /\b(rate|total_amount|admin_notes|amount|price|cost)\b/i;

function fakeReads(role: LocalRole, rows: Record<string, unknown[]>, inMirror = true): LocalReads & { getAll: jest.Mock } {
  return {
    hasSynced: () => true,
    role: () => role,
    getAll: jest.fn(async (sql: string) => rows[sql] ?? []),
    getOptional: jest.fn(async (sql: string) => (sql === SQL_JOB_IN_MIRROR_FOR_VARIATIONS && inMirror ? { id: "job-1" } : null)),
  } as LocalReads & { getAll: jest.Mock };
}

const SQLITE_VARIATIONS = [
  {
    id: "v1", job_id: "job-1", variation_type_id: "vt-1", custom_name: null, description: "Extra dig",
    quantity: "2", unit: "hr", photo_storage_path: "job-1/variations/v1.jpg", status: "auto_approved",
    logged_by: "tech-7", logged_at: "2026-10-09T01:00:00Z",
  },
  {
    id: "v2", job_id: "job-1", variation_type_id: null, custom_name: "Odd fix", description: null,
    quantity: 1, unit: "ea", photo_storage_path: null, status: "pending_approval",
    logged_by: "tech-7", logged_at: "2026-10-08T01:00:00Z",
  },
];
const EXPECTED: TechnicianVariation[] = [
  { ...SQLITE_VARIATIONS[0], quantity: 2 } as TechnicianVariation,
  SQLITE_VARIATIONS[1] as TechnicianVariation,
];

afterEach(() => {
  resetSourceForTests();
  mockCalls.length = 0;
  for (const k of Object.keys(mockResponses)) delete mockResponses[k];
});

describe("listJobVariationsForTechnician", () => {
  it("local and remote return identical, money-free shapes", async () => {
    setLocalReads(fakeReads("technician", { [SQL_TECH_JOB_VARIATIONS]: SQLITE_VARIATIONS }));
    const local = await listJobVariationsForTechnician("job-1");
    expect(mockCalls).toHaveLength(0);

    resetSourceForTests();
    mockResponses.job_variations_public = { data: [{ ...SQLITE_VARIATIONS[0], quantity: 2 }, SQLITE_VARIATIONS[1]], error: null };
    const remote = await listJobVariationsForTechnician("job-1");

    expect(local).toEqual(EXPECTED);
    expect(remote).toEqual(EXPECTED);
    for (const row of [...local, ...remote]) {
      expect(Object.keys(row).filter((k) => MONEY.test(k))).toEqual([]);
    }
  });

  it("names no money column in the SQL or the PostgREST select, and reads the public view remotely", async () => {
    expect(SQL_TECH_JOB_VARIATIONS).not.toMatch(MONEY);
    await listJobVariationsForTechnician("job-1");
    expect(mockCalls[0].table).toBe("job_variations_public");
    const select = mockCalls[0].chain.find(([m]) => m === "select")![1][0] as string;
    expect(select).not.toMatch(MONEY);
    expect(select).not.toContain("*");
  });

  it("orders by logged_at on BOTH paths (created_at is not in the technician stream)", async () => {
    expect(SQL_TECH_JOB_VARIATIONS).toMatch(/ORDER BY logged_at DESC/);
    await listJobVariationsForTechnician("job-1");
    expect(mockCalls[0].chain).toContainEqual(["order", ["logged_at", { ascending: false }]]);
  });

  it("a job absent from the mirror answers from Supabase", async () => {
    const db = fakeReads("technician", {}, false);
    setLocalReads(db);
    await listJobVariationsForTechnician("job-1");
    expect(db.getAll).not.toHaveBeenCalled();
    expect(mockCalls.map((c) => c.table)).toEqual(["job_variations_public"]);
  });
});

describe("listActiveVariationTypes", () => {
  it("local and remote return identical shapes (SQLite 1/0 → boolean), rate-free", async () => {
    setLocalReads(
      fakeReads("technician", {
        [SQL_ACTIVE_VARIATION_TYPES]: [
          { id: "t1", name: "Excavation", unit: "hr", auto_approve: 1 },
          { id: "t2", name: "Custom", unit: "ea", auto_approve: 0 },
        ],
      })
    );
    const local = await listActiveVariationTypes();

    resetSourceForTests();
    mockResponses.variation_types_public = {
      data: [
        { id: "t1", name: "Excavation", unit: "hr", auto_approve: true },
        { id: "t2", name: "Custom", unit: "ea", auto_approve: false },
      ],
      error: null,
    };
    const remote = await listActiveVariationTypes();
    const expected: VariationTypeOption[] = [
      { id: "t1", name: "Excavation", unit: "hr", auto_approve: true },
      { id: "t2", name: "Custom", unit: "ea", auto_approve: false },
    ];
    expect(local).toEqual(expected);
    expect(remote).toEqual(expected);
    expect(SQL_ACTIVE_VARIATION_TYPES).not.toMatch(MONEY);
    expect(mockCalls[0].chain).toContainEqual(["eq", ["is_active", true]]);
  });
});
