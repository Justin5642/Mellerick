// jobBilling through the LocalReads seam: a fake device DB is injected via
// setLocalReads and fed SQLite-shaped rows (string numerics as the schema-drift
// guard, NULL FKs, NULL join aliases); we assert the mapped output equals the
// PostgREST-shaped interfaces, plus the exact SQL/params the fake received.
// The supabase client is mocked per backflow.test.ts so the native
// AsyncStorage chain never loads — and so the role-gate test can prove the
// remote path was taken (a technician's local base tables are EMPTY; the gate
// keeps the Time tab's allocation picker on the *_public views).
jest.mock("../../supabase", () => {
  const builder: any = {};
  Object.assign(builder, {
    select: jest.fn(() => builder),
    eq: jest.fn(() => builder),
    order: jest.fn(() => builder),
    single: jest.fn(() => builder),
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
  getJobBilling,
  getJobCostCentres,
  getJobEquipment,
  SQL_JOB_BILLING_EXPENSES,
  SQL_JOB_BILLING_ITEMS,
  SQL_JOB_BILLING_JOB,
  SQL_JOB_BILLING_PO_COST_CENTERS,
  SQL_JOB_BILLING_POS,
  SQL_JOB_COST_CENTRES,
  SQL_JOB_EQUIPMENT_OPTIONS,
  SQL_JOB_EQUIPMENT_USAGE,
  type JobBilling,
  type JobCostCentre,
  type JobEquipment,
} from "./jobBilling";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

const EXPECTED_COST_CENTRES = norm(`
  SELECT cc.id, cc.name, cc.code, po.po_number
  FROM po_cost_centers cc
  JOIN purchase_orders po ON po.id = cc.po_id
  WHERE po.job_id = ?`);

const EXPECTED_JOB = norm(`SELECT job_number, title FROM jobs WHERE id = ?`);

const EXPECTED_ITEMS = norm(`
  SELECT id, name, description, quantity, unit_price,
         ROUND(quantity * unit_price, 2) AS total
  FROM job_items WHERE job_id = ? ORDER BY created_at, id`);

const EXPECTED_EXPENSES = norm(`
  SELECT id, supplier_name, category, description, amount, gst_amount, invoice_number,
         invoice_date, receipt_storage_path, cost_center_id
  FROM job_expenses WHERE job_id = ? ORDER BY created_at DESC`);

const EXPECTED_POS = norm(`
  SELECT id, po_number, client_reference, total_value
  FROM purchase_orders WHERE job_id = ? ORDER BY created_at`);

const EXPECTED_PO_COST_CENTERS = norm(`
  SELECT id, po_id, name, allocated_amount
  FROM po_cost_centers WHERE po_id IN (SELECT id FROM purchase_orders WHERE job_id = ?)`);

const EXPECTED_EQUIP_USAGE = norm(`
  SELECT u.id, u.equipment_id, u.usage_date, u.hours, u.notes,
         e.name AS equipment_name, e.category AS equipment_category
  FROM equipment_usage_log u LEFT JOIN equipment e ON e.id = u.equipment_id
  WHERE u.job_id = ? ORDER BY u.usage_date DESC, u.created_at DESC`);

const EXPECTED_EQUIP_OPTIONS = norm(`
  SELECT id, name, category, purchase_cost, estimated_life_years, insurance_annual,
         maintenance_annual, registration_annual, other_annual_costs,
         fuel_cost_per_hour, target_hours_per_year
  FROM equipment WHERE is_active = 1 ORDER BY category COLLATE NOCASE, name COLLATE NOCASE`);

function fakeReads(over: Partial<LocalReads> = {}): LocalReads {
  return {
    hasSynced: () => true,
    role: () => "office" as LocalRole,
    getAll: jest.fn().mockResolvedValue([]),
    getOptional: jest.fn().mockResolvedValue(null),
    ...over,
  };
}

/** getAll fake that dispatches on the normalized SQL it receives. */
function dispatchGetAll(bySql: Record<string, unknown[]>): jest.Mock {
  return jest.fn(async (sql: string) => {
    const rows = bySql[norm(sql)];
    if (!rows) throw new Error(`unexpected SQL: ${norm(sql)}`);
    return rows;
  });
}

afterEach(() => {
  resetSourceForTests();
  jest.clearAllMocks();
});

describe("getJobCostCentres (local path)", () => {
  it("reads the BASE tables and maps rows to JobCostCentre", async () => {
    const getAll = dispatchGetAll({
      [EXPECTED_COST_CENTRES]: [
        { id: "cc-1", name: "Stage 1 — dig", code: "S1", po_number: "PO-1001" },
        { id: "cc-2", name: "Stage 2 — reline", code: null, po_number: "PO-1002" },
      ],
    });
    setLocalReads(fakeReads({ getAll }));

    const result = await getJobCostCentres("job-1");

    const expected: JobCostCentre[] = [
      { id: "cc-1", name: "Stage 1 — dig", code: "S1", po_number: "PO-1001" },
      { id: "cc-2", name: "Stage 2 — reline", code: null, po_number: "PO-1002" },
    ];
    expect(result).toEqual(expected);

    expect(getAll).toHaveBeenCalledTimes(1);
    const [sql, params] = getAll.mock.calls[0];
    expect(norm(sql)).toBe(EXPECTED_COST_CENTRES);
    expect(norm(SQL_JOB_COST_CENTRES)).toBe(EXPECTED_COST_CENTRES);
    expect(params).toEqual(["job-1"]);
    expect(supabase.from as jest.Mock).not.toHaveBeenCalled();
  });

  it("never touches the local DB for a technician — the *_public views path stays", async () => {
    const getAll = jest.fn().mockResolvedValue([]);
    const getOptional = jest.fn().mockResolvedValue(null);
    setLocalReads(fakeReads({ getAll, getOptional, role: () => "technician" as LocalRole }));

    const result = await getJobCostCentres("job-1");

    // A technician's local base tables are silently EMPTY (office-only streams);
    // the gate must force the Supabase views, where RLS-scoped rows are real.
    expect(getAll).not.toHaveBeenCalled();
    expect(getOptional).not.toHaveBeenCalled();
    expect(supabase.from as jest.Mock).toHaveBeenCalledWith("purchase_orders_public");
    expect(result).toEqual([]);
  });
});

describe("getJobBilling (local path)", () => {
  it("maps SQLite-shaped rows (string numerics, computed item total) to JobBilling", async () => {
    const getAll = dispatchGetAll({
      [EXPECTED_ITEMS]: [
        // string numerics: the coercion contract, not just the happy path
        { id: "li-1", name: "Reline 20m", description: "Sectional", quantity: "2.5", unit_price: "100.10", total: "250.25" },
        { id: "li-2", name: "Junction cut", description: null, quantity: 1, unit_price: 480, total: 480 },
      ],
      [EXPECTED_EXPENSES]: [
        {
          id: "ex-1",
          supplier_name: "Reece",
          category: "materials",
          description: null,
          amount: "89.90",
          gst_amount: 8.99,
          invoice_number: "INV-77",
          invoice_date: "2026-07-01",
          receipt_storage_path: null,
          cost_center_id: null, // null FK stays null
        },
      ],
      [EXPECTED_POS]: [
        { id: "po-1", po_number: "PO-1001", client_reference: "CR-9", total_value: "15000" },
        { id: "po-2", po_number: "PO-1002", client_reference: null, total_value: 2000 },
      ],
      [EXPECTED_PO_COST_CENTERS]: [
        { id: "cc-1", po_id: "po-1", name: "Stage 1", allocated_amount: "1500.50" },
        { id: "cc-2", po_id: "po-1", name: "Stage 2", allocated_amount: 2500 },
        // po-2 has no cost centres → its embed must be [], as PostgREST returns
      ],
    });
    const getOptional = jest.fn().mockResolvedValue({ job_number: "1042", title: "Reline sewer main" });
    setLocalReads(fakeReads({ getAll, getOptional }));

    const result = await getJobBilling("job-1");

    const expected: JobBilling = {
      jobNumber: 1042,
      jobTitle: "Reline sewer main",
      lineItems: [
        { id: "li-1", name: "Reline 20m", description: "Sectional", quantity: 2.5, unit_price: 100.1, total: 250.25 },
        { id: "li-2", name: "Junction cut", description: null, quantity: 1, unit_price: 480, total: 480 },
      ],
      expenses: [
        {
          id: "ex-1",
          supplier_name: "Reece",
          category: "materials",
          description: null,
          amount: 89.9,
          gst_amount: 8.99,
          invoice_number: "INV-77",
          invoice_date: "2026-07-01",
          receipt_storage_path: null,
          cost_center_id: null,
        },
      ],
      purchaseOrders: [
        {
          id: "po-1",
          po_number: "PO-1001",
          client_reference: "CR-9",
          total_value: 15000,
          po_cost_centers: [
            { id: "cc-1", name: "Stage 1", allocated_amount: 1500.5 },
            { id: "cc-2", name: "Stage 2", allocated_amount: 2500 },
          ],
        },
        { id: "po-2", po_number: "PO-1002", client_reference: null, total_value: 2000, po_cost_centers: [] },
      ],
    };
    expect(result).toEqual(expected);

    expect(getOptional).toHaveBeenCalledTimes(1);
    const [jobSql, jobParams] = getOptional.mock.calls[0];
    expect(norm(jobSql)).toBe(EXPECTED_JOB);
    expect(norm(SQL_JOB_BILLING_JOB)).toBe(EXPECTED_JOB);
    expect(jobParams).toEqual(["job-1"]);

    expect(getAll).toHaveBeenCalledTimes(4);
    const calls = getAll.mock.calls.map(([sql, params]: [string, unknown[]]) => [norm(sql), params]);
    expect(calls).toEqual([
      [EXPECTED_ITEMS, ["job-1"]],
      [EXPECTED_EXPENSES, ["job-1"]],
      [EXPECTED_POS, ["job-1"]],
      [EXPECTED_PO_COST_CENTERS, ["job-1"]],
    ]);
    expect(norm(SQL_JOB_BILLING_ITEMS)).toBe(EXPECTED_ITEMS);
    expect(norm(SQL_JOB_BILLING_EXPENSES)).toBe(EXPECTED_EXPENSES);
    expect(norm(SQL_JOB_BILLING_POS)).toBe(EXPECTED_POS);
    expect(norm(SQL_JOB_BILLING_PO_COST_CENTERS)).toBe(EXPECTED_PO_COST_CENTERS);
    expect(supabase.from as jest.Mock).not.toHaveBeenCalled();
  });

  it("returns null when the job row is absent", async () => {
    const getAll = dispatchGetAll({
      [EXPECTED_ITEMS]: [],
      [EXPECTED_EXPENSES]: [],
      [EXPECTED_POS]: [],
      [EXPECTED_PO_COST_CENTERS]: [],
    });
    const getOptional = jest.fn().mockResolvedValue(null);
    setLocalReads(fakeReads({ getAll, getOptional }));

    expect(await getJobBilling("job-missing")).toBeNull();
    expect(supabase.from as jest.Mock).not.toHaveBeenCalled();
  });
});

describe("getJobEquipment (local path)", () => {
  it("prices usage from the ACTIVE-only map: $0 for a deactivated item, name from the join", async () => {
    const getAll = dispatchGetAll({
      [EXPECTED_EQUIP_USAGE]: [
        // active item: dep 10000/10 + 500+300+200+0 = 2000 fixed; fuel 10*500 = 5000;
        // 7000 / 500 target hours = $14/h. "2.5" hours → $35.
        { id: "u-1", equipment_id: "e-1", usage_date: "2026-07-20", hours: "2.5", notes: "trench", equipment_name: "Mini excavator", equipment_category: "Excavation" },
        // deactivated: not in the active options → $0, but the joined name shows
        { id: "u-2", equipment_id: "e-gone", usage_date: "2026-07-19", hours: 3, notes: null, equipment_name: "Old digger", equipment_category: "Excavation" },
        // missing join (equipment row absent locally) → PostgREST-null fallbacks
        { id: "u-3", equipment_id: "e-void", usage_date: "2026-07-18", hours: 1, notes: null, equipment_name: null, equipment_category: null },
      ],
      [EXPECTED_EQUIP_OPTIONS]: [
        {
          id: "e-1",
          name: "Mini excavator",
          category: "Excavation",
          purchase_cost: "10000",
          estimated_life_years: 10,
          insurance_annual: "500",
          maintenance_annual: 300,
          registration_annual: 200,
          other_annual_costs: null,
          fuel_cost_per_hour: "10",
          target_hours_per_year: 500,
        },
      ],
    });
    setLocalReads(fakeReads({ getAll }));

    const result = await getJobEquipment("job-1");

    const expected: JobEquipment = {
      usage: [
        { id: "u-1", equipment_id: "e-1", equipment_name: "Mini excavator", category: "Excavation", usage_date: "2026-07-20", hours: 2.5, notes: "trench", cost_per_hour: 14, total_cost: 35 },
        { id: "u-2", equipment_id: "e-gone", equipment_name: "Old digger", category: "Excavation", usage_date: "2026-07-19", hours: 3, notes: null, cost_per_hour: 0, total_cost: 0 },
        { id: "u-3", equipment_id: "e-void", equipment_name: "Unknown equipment", category: "", usage_date: "2026-07-18", hours: 1, notes: null, cost_per_hour: 0, total_cost: 0 },
      ],
      options: [{ id: "e-1", name: "Mini excavator", category: "Excavation", cost_per_hour: 14 }],
    };
    expect(result).toEqual(expected);

    expect(getAll).toHaveBeenCalledTimes(2);
    const [usageSql, usageParams] = getAll.mock.calls[0];
    expect(norm(usageSql)).toBe(EXPECTED_EQUIP_USAGE);
    expect(norm(SQL_JOB_EQUIPMENT_USAGE)).toBe(EXPECTED_EQUIP_USAGE);
    expect(usageParams).toEqual(["job-1"]);
    const [optSql, optParams] = getAll.mock.calls[1];
    expect(norm(optSql)).toBe(EXPECTED_EQUIP_OPTIONS);
    expect(norm(SQL_JOB_EQUIPMENT_OPTIONS)).toBe(EXPECTED_EQUIP_OPTIONS);
    expect(optParams).toBeUndefined(); // no bound params — active-only literal
    expect(supabase.from as jest.Mock).not.toHaveBeenCalled();
  });
});
