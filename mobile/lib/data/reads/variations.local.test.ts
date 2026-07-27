// getJobVariationsForApproval through the LocalReads seam: a fake device DB is
// injected via setLocalReads and fed SQLite-shaped rows; we assert the mapped
// output equals the PostgREST-shaped VariationForApproval interface, plus the
// exact SQL/params the fake received. The supabase client is mocked per
// backflow.test.ts so the native AsyncStorage chain never loads — and so the
// role-gate test can prove the remote path was taken. That gate is
// LOAD-BEARING here: a technician's local job_variations rows are streamed
// rate-stripped, so serving them locally would silently answer with NULL
// rates where today's Supabase path raises a loud RLS denial.
jest.mock("../../supabase", () => {
  const builder: any = {};
  Object.assign(builder, {
    select: jest.fn(() => builder),
    eq: jest.fn(() => builder),
    order: jest.fn(() => builder),
    then: (resolve: (v: unknown) => void) => resolve({ data: [] }),
  });
  return { supabase: { from: jest.fn(() => builder) } };
});

import { supabase } from "../../supabase";
import {
  resetSourceForTests,
  setLocalReads,
  type LocalReads,
  type LocalRole,
} from "./source";
import {
  getJobVariationsForApproval,
  SQL_JOB_VARIATIONS_FOR_APPROVAL,
  type VariationForApproval,
} from "./variations";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

const EXPECTED_SQL = norm(`
  SELECT v.id, v.variation_type_id, v.custom_name, v.description, v.quantity, v.unit,
         v.rate, v.total_amount, v.admin_notes, v.photo_storage_path, v.status, v.created_at,
         t.name AS variation_type_name
  FROM job_variations v LEFT JOIN variation_types t ON t.id = v.variation_type_id
  WHERE v.job_id = ? ORDER BY v.created_at DESC`);

function fakeReads(over: Partial<LocalReads> = {}): LocalReads {
  return {
    hasSynced: () => true,
    role: () => "office" as LocalRole,
    getAll: jest.fn().mockResolvedValue([]),
    getOptional: jest.fn().mockResolvedValue(null),
    ...over,
  };
}

describe("getJobVariationsForApproval (local path)", () => {
  afterEach(() => {
    resetSourceForTests();
    jest.clearAllMocks();
  });

  it("maps SQLite-shaped rows to the PostgREST-shaped VariationForApproval", async () => {
    const sqliteRows = [
      {
        // column.real → JS number is the declared contract…
        id: "var-1",
        variation_type_id: "vt-1",
        custom_name: null,
        description: "Extra excavation",
        quantity: 2.5,
        unit: "hr",
        rate: 180,
        total_amount: 450,
        admin_notes: "approved on site",
        photo_storage_path: "variations/var-1.jpg",
        status: "approved",
        created_at: "2026-07-20T03:15:00Z",
        variation_type_name: "Excavation",
      },
      {
        // …but string numerics and NULLs must still coerce (schema drift
        // guard) — and a null FK must nest to `variation_types: null`, not
        // `{ name: null }`.
        id: "var-2",
        variation_type_id: null,
        custom_name: "Custom stormwater fix",
        description: null,
        quantity: "1",
        unit: "ea",
        rate: "1234.50",
        total_amount: null,
        admin_notes: null,
        photo_storage_path: null,
        status: "pending_approval",
        created_at: "2026-07-19T22:00:00Z",
        variation_type_name: null,
      },
    ];
    const getAll = jest.fn().mockResolvedValue(sqliteRows);
    setLocalReads(fakeReads({ getAll }));

    const result = await getJobVariationsForApproval("job-1");

    const expected: VariationForApproval[] = [
      {
        id: "var-1",
        variation_type_id: "vt-1",
        custom_name: null,
        description: "Extra excavation",
        quantity: 2.5,
        unit: "hr",
        rate: 180,
        total_amount: 450,
        admin_notes: "approved on site",
        photo_storage_path: "variations/var-1.jpg",
        status: "approved",
        created_at: "2026-07-20T03:15:00Z",
        variation_types: { name: "Excavation" },
      },
      {
        id: "var-2",
        variation_type_id: null,
        custom_name: "Custom stormwater fix",
        description: null,
        quantity: 1,
        unit: "ea",
        rate: 1234.5,
        total_amount: null,
        admin_notes: null,
        photo_storage_path: null,
        status: "pending_approval",
        created_at: "2026-07-19T22:00:00Z",
        variation_types: null,
      },
    ];
    expect(result).toEqual(expected);

    expect(getAll).toHaveBeenCalledTimes(1);
    const [sql, params] = getAll.mock.calls[0];
    expect(norm(sql)).toBe(EXPECTED_SQL);
    expect(norm(SQL_JOB_VARIATIONS_FOR_APPROVAL)).toBe(EXPECTED_SQL);
    expect(params).toEqual(["job-1"]); // job id stays a bound parameter
    expect(supabase.from as jest.Mock).not.toHaveBeenCalled();
  });

  it("serves an admin locally too", async () => {
    const getAll = jest.fn().mockResolvedValue([]);
    setLocalReads(fakeReads({ getAll, role: () => "admin" as LocalRole }));

    const result = await getJobVariationsForApproval("job-9");

    expect(getAll).toHaveBeenCalledTimes(1);
    expect(getAll.mock.calls[0][1]).toEqual(["job-9"]);
    expect(supabase.from as jest.Mock).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("never touches the local DB for a technician — RLS stays the loud gate", async () => {
    const getAll = jest.fn().mockResolvedValue([]);
    setLocalReads(fakeReads({ getAll, role: () => "technician" as LocalRole }));

    const result = await getJobVariationsForApproval("job-1");

    // Locally a technician would read their own rows with rate = NULL — a
    // silent wrong answer. The role gate must force the Supabase path where
    // RLS denies loudly.
    expect(getAll).not.toHaveBeenCalled();
    expect(supabase.from as jest.Mock).toHaveBeenCalledWith("job_variations");
    expect(result).toEqual([]);
  });
});
