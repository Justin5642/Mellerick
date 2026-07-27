// London-school tests for the fleet local reads: a fake LocalReads is injected
// via setLocalReads(); we assert (a) the exact SQL + params the fake receives
// (normalized whitespace), (b) that SQLite-shaped rows (numbers for numerics —
// the schema declares column.real — null FKs, no embeds) map to the exact
// PostgREST-shaped interfaces screens consume, and (c) role-gating: a
// technician with a ready local DB is still routed to Supabase.
//
// Supabase is mocked per the existing pattern in backflow.test.ts, extended
// with a chainable thenable so the remote path can actually run.
jest.mock("../../supabase", () => {
  const result = { data: null };
  const builder: Record<string, unknown> = {
    then: (resolve: (v: unknown) => unknown) => resolve(result),
  };
  for (const m of ["select", "eq", "order", "single"]) {
    builder[m] = jest.fn(() => builder);
  }
  return { supabase: { from: jest.fn(() => builder), storage: { from: jest.fn() } } };
});

import { supabase } from "../../supabase";
import { resetSourceForTests, setLocalReads, type LocalReads } from "./source";
import {
  getEquipment,
  listEquipment,
  listEquipmentDocuments,
  listEquipmentExpenses,
  listEquipmentUsage,
  listInactiveEquipment,
  SQL_GET_EQUIPMENT,
  SQL_LIST_EQUIPMENT,
  SQL_LIST_EQUIPMENT_EXPENSES,
  SQL_LIST_EQUIPMENT_USAGE,
  type Equipment,
} from "./fleet";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

type FakeReads = LocalReads & { getAll: jest.Mock; getOptional: jest.Mock };
function fakeReads(over: Partial<LocalReads> = {}): FakeReads {
  return {
    hasSynced: () => true,
    role: () => "office",
    getAll: jest.fn().mockResolvedValue([]),
    getOptional: jest.fn().mockResolvedValue(null),
    ...over,
  } as FakeReads;
}

// SQLite-shaped rows: LEFT JOIN alias instead of an embed, numerics as numbers
// (column.real casts them), nullable FK genuinely null.
const RAW_E1 = {
  id: "e1",
  name: "Excavator 1.7t",
  category: "Plant",
  registration: "1AB2CD",
  purchase_cost: 54990.5,
  purchase_date: "2022-01-15",
  estimated_life_years: 10,
  insurance_annual: 1200,
  maintenance_annual: 850.25,
  registration_annual: 890,
  other_annual_costs: 0,
  fuel_cost_per_hour: 18.5,
  target_hours_per_year: 600,
  notes: "Serviced Jan",
  assigned_to: "p1",
  assigned_profile_name: "Tam Nguyen",
};

const RAW_E2 = {
  id: "e2",
  name: "Trailer",
  category: "Vehicles",
  registration: null,
  purchase_cost: 3200,
  purchase_date: null,
  estimated_life_years: 15,
  insurance_annual: 0,
  maintenance_annual: 120,
  registration_annual: 160.4,
  other_annual_costs: 0,
  fuel_cost_per_hour: 0,
  target_hours_per_year: 400,
  notes: null,
  assigned_to: null,
  assigned_profile_name: null,
};

// The PostgREST shapes the screens consume today.
const E1: Equipment = {
  id: "e1",
  name: "Excavator 1.7t",
  category: "Plant",
  registration: "1AB2CD",
  purchase_cost: 54990.5,
  purchase_date: "2022-01-15",
  estimated_life_years: 10,
  insurance_annual: 1200,
  maintenance_annual: 850.25,
  registration_annual: 890,
  other_annual_costs: 0,
  fuel_cost_per_hour: 18.5,
  target_hours_per_year: 600,
  notes: "Serviced Jan",
  assigned_to: "p1",
  assigned_profile: { full_name: "Tam Nguyen" },
};

const E2: Equipment = {
  id: "e2",
  name: "Trailer",
  category: "Vehicles",
  registration: null,
  purchase_cost: 3200,
  purchase_date: null,
  estimated_life_years: 15,
  insurance_annual: 0,
  maintenance_annual: 120,
  registration_annual: 160.4,
  other_annual_costs: 0,
  fuel_cost_per_hour: 0,
  target_hours_per_year: 400,
  notes: null,
  assigned_to: null,
  assigned_profile: null, // FK null → whole embed null, not {full_name: null}
};

describe("fleet local reads", () => {
  afterEach(() => {
    resetSourceForTests();
    jest.clearAllMocks();
  });

  it("listEquipment: maps joined SQLite rows to the PostgREST shape and issues the design SQL", async () => {
    const db = fakeReads();
    db.getAll.mockResolvedValue([RAW_E1, RAW_E2]);
    setLocalReads(db);

    await expect(listEquipment()).resolves.toEqual([E1, E2]);

    expect(db.getAll).toHaveBeenCalledTimes(1);
    const [sql, params] = db.getAll.mock.calls[0];
    expect(norm(sql)).toBe(norm(SQL_LIST_EQUIPMENT));
    expect(norm(sql)).toBe(
      "SELECT e.id, e.name, e.category, e.registration, e.purchase_cost, e.purchase_date, " +
        "e.estimated_life_years, e.insurance_annual, e.maintenance_annual, " +
        "e.registration_annual, e.other_annual_costs, e.fuel_cost_per_hour, " +
        "e.target_hours_per_year, e.notes, e.assigned_to, " +
        "p.full_name AS assigned_profile_name " +
        "FROM equipment e LEFT JOIN profiles p ON p.id = e.assigned_to " +
        "WHERE e.is_active = ? " +
        "ORDER BY e.category COLLATE NOCASE, e.name COLLATE NOCASE"
    );
    expect(params).toEqual([1]);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("listInactiveEquipment: same projection, is_active bound to 0", async () => {
    const db = fakeReads();
    db.getAll.mockResolvedValue([RAW_E2]);
    setLocalReads(db);

    await expect(listInactiveEquipment()).resolves.toEqual([E2]);

    const [sql, params] = db.getAll.mock.calls[0];
    expect(norm(sql)).toBe(norm(SQL_LIST_EQUIPMENT));
    expect(params).toEqual([0]);
  });

  it("getEquipment: getOptional with the shared projection filtered by id", async () => {
    const db = fakeReads();
    db.getOptional.mockResolvedValue(RAW_E1);
    setLocalReads(db);

    await expect(getEquipment("e1")).resolves.toEqual(E1);

    expect(db.getOptional).toHaveBeenCalledTimes(1);
    const [sql, params] = db.getOptional.mock.calls[0];
    expect(norm(sql)).toBe(norm(SQL_GET_EQUIPMENT));
    expect(norm(sql)).toContain("FROM equipment e LEFT JOIN profiles p ON p.id = e.assigned_to WHERE e.id = ?");
    expect(params).toEqual(["e1"]);
  });

  it("getEquipment: absent row maps to null, not undefined", async () => {
    const db = fakeReads();
    setLocalReads(db); // getOptional already resolves null
    await expect(getEquipment("missing")).resolves.toBeNull();
  });

  it("listEquipmentExpenses: maps rows and orders expense_date DESC, created_at DESC", async () => {
    const db = fakeReads();
    db.getAll.mockResolvedValue([
      {
        id: "x1",
        category: "fuel",
        supplier_name: "BP",
        description: null,
        invoice_number: "INV-9",
        expense_date: "2026-07-01",
        amount: 88.4,
        gst_amount: 8.04,
        receipt_storage_path: "receipts/x1.jpg",
      },
      {
        id: "x2",
        category: "maintenance",
        supplier_name: null,
        description: "Blade replacement",
        invoice_number: null,
        expense_date: null,
        amount: 250,
        gst_amount: 0,
        receipt_storage_path: null,
      },
    ]);
    setLocalReads(db);

    await expect(listEquipmentExpenses("e1")).resolves.toEqual([
      {
        id: "x1",
        category: "fuel",
        supplier_name: "BP",
        description: null,
        invoice_number: "INV-9",
        expense_date: "2026-07-01",
        amount: 88.4,
        gst_amount: 8.04,
        receipt_storage_path: "receipts/x1.jpg",
      },
      {
        id: "x2",
        category: "maintenance",
        supplier_name: null,
        description: "Blade replacement",
        invoice_number: null,
        expense_date: null,
        amount: 250,
        gst_amount: 0,
        receipt_storage_path: null,
      },
    ]);

    const [sql, params] = db.getAll.mock.calls[0];
    expect(norm(sql)).toBe(norm(SQL_LIST_EQUIPMENT_EXPENSES));
    expect(norm(sql)).toBe(
      "SELECT id, category, supplier_name, description, invoice_number, expense_date, " +
        "amount, gst_amount, receipt_storage_path " +
        "FROM equipment_expenses WHERE equipment_id = ? " +
        "ORDER BY expense_date DESC, created_at DESC"
    );
    expect(params).toEqual(["e1"]);
  });

  it("listEquipmentUsage: maps rows and orders usage_date DESC, created_at DESC", async () => {
    const db = fakeReads();
    db.getAll.mockResolvedValue([
      { id: "u1", usage_date: "2026-07-20", hours: 6.5, notes: null, job_id: "j1" },
      { id: "u2", usage_date: "2026-07-18", hours: 2, notes: "yard move", job_id: null },
    ]);
    setLocalReads(db);

    await expect(listEquipmentUsage("e1")).resolves.toEqual([
      { id: "u1", usage_date: "2026-07-20", hours: 6.5, notes: null, job_id: "j1" },
      { id: "u2", usage_date: "2026-07-18", hours: 2, notes: "yard move", job_id: null },
    ]);

    const [sql, params] = db.getAll.mock.calls[0];
    expect(norm(sql)).toBe(norm(SQL_LIST_EQUIPMENT_USAGE));
    expect(norm(sql)).toBe(
      "SELECT id, usage_date, hours, notes, job_id " +
        "FROM equipment_usage_log WHERE equipment_id = ? " +
        "ORDER BY usage_date DESC, created_at DESC"
    );
    expect(params).toEqual(["e1"]);
  });

  it("role gate: a technician with a ready local DB is routed to Supabase — getAll never runs", async () => {
    const db = fakeReads({ role: () => "technician" });
    setLocalReads(db);

    await expect(listEquipment()).resolves.toEqual([]); // mocked remote: data null → []

    expect(db.getAll).not.toHaveBeenCalled();
    expect(db.getOptional).not.toHaveBeenCalled();
    expect(supabase.from).toHaveBeenCalledWith("equipment");
  });

  it("listEquipmentDocuments stays Supabase-only even with a ready local DB (table not in the publication)", async () => {
    const db = fakeReads();
    setLocalReads(db);

    await expect(listEquipmentDocuments("e1")).resolves.toEqual([]);

    expect(db.getAll).not.toHaveBeenCalled();
    expect(db.getOptional).not.toHaveBeenCalled();
    expect(supabase.from).toHaveBeenCalledWith("equipment_documents");
  });
});
