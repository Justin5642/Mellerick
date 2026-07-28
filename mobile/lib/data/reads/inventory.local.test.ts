// listInventory through the LocalReads seam: a fake device DB is injected via
// setLocalReads and fed SQLite-shaped rows; we assert the mapped output equals
// the PostgREST-shaped InventoryItem interface, plus the exact SQL/params the
// fake received. The supabase client is mocked per backflow.test.ts so the
// native AsyncStorage chain never loads — and so the role-gate test can prove
// the remote path was taken.
jest.mock("../../supabase", () => {
  const builder: any = {};
  Object.assign(builder, {
    select: jest.fn(() => builder),
    eq: jest.fn(() => builder),
    order: jest.fn(() => builder),
    or: jest.fn(() => builder),
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
import { listInventory, SQL_LIST_INVENTORY, type InventoryItem } from "./inventory";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

const EXPECTED_SQL = norm(`
  SELECT id, name, sku, description, category, unit,
         quantity_on_hand, reorder_level, unit_cost, unit_sell, supplier
  FROM inventory
  WHERE is_active = 1
    AND (?1 IS NULL OR name LIKE '%'||?1||'%' OR sku LIKE '%'||?1||'%')
  ORDER BY category IS NULL, category COLLATE NOCASE, name COLLATE NOCASE`);

function fakeReads(over: Partial<LocalReads> = {}): LocalReads {
  return {
    hasSynced: () => true,
    role: () => "office" as LocalRole,
    getAll: jest.fn().mockResolvedValue([]),
    getOptional: jest.fn().mockResolvedValue(null),
    ...over,
  };
}

describe("listInventory (local path)", () => {
  afterEach(() => {
    resetSourceForTests();
    jest.clearAllMocks();
  });

  it("maps SQLite-shaped rows to the PostgREST-shaped InventoryItem", async () => {
    const sqliteRows = [
      {
        // column.real → JS number is the declared contract…
        id: "inv-1",
        name: "Copper Pipe 20mm",
        sku: "CP-20",
        description: "Type B hard drawn",
        category: "Pipe",
        unit: "m",
        quantity_on_hand: 42,
        reorder_level: 10,
        unit_cost: 12.5,
        unit_sell: 19.95,
        supplier: "Reece",
      },
      {
        // …but string numerics and NULLs must still coerce (schema drift guard).
        id: "inv-2",
        name: "Ball Valve",
        sku: null,
        description: null,
        category: null,
        unit: null,
        quantity_on_hand: "8",
        reorder_level: null,
        unit_cost: "1234.50",
        unit_sell: "0",
        supplier: null,
      },
    ];
    const getAll = jest.fn().mockResolvedValue(sqliteRows);
    setLocalReads(fakeReads({ getAll }));

    const result = await listInventory();

    const expected: InventoryItem[] = [
      {
        id: "inv-1",
        name: "Copper Pipe 20mm",
        sku: "CP-20",
        description: "Type B hard drawn",
        category: "Pipe",
        unit: "m",
        quantity_on_hand: 42,
        reorder_level: 10,
        unit_cost: 12.5,
        unit_sell: 19.95,
        supplier: "Reece",
      },
      {
        id: "inv-2",
        name: "Ball Valve",
        sku: null,
        description: null,
        category: null,
        unit: null,
        quantity_on_hand: 8,
        reorder_level: 0,
        unit_cost: 1234.5,
        unit_sell: 0,
        supplier: null,
      },
    ];
    expect(result).toEqual(expected);

    expect(getAll).toHaveBeenCalledTimes(1);
    const [sql, params] = getAll.mock.calls[0];
    expect(norm(sql)).toBe(EXPECTED_SQL);
    expect(norm(SQL_LIST_INVENTORY)).toBe(EXPECTED_SQL);
    expect(params).toEqual([null]); // no search term → ?1 IS NULL branch
    expect(supabase.from as jest.Mock).not.toHaveBeenCalled();
  });

  it("strips [,()%] from the search term and binds it as one LIKE parameter", async () => {
    const getAll = jest.fn().mockResolvedValue([]);
    setLocalReads(fakeReads({ getAll }));

    await listInventory("cop%per");

    expect(getAll).toHaveBeenCalledTimes(1);
    const [sql, params] = getAll.mock.calls[0];
    expect(norm(sql)).toBe(EXPECTED_SQL);
    expect(params).toEqual(["cop per"]); // % stripped, term bound — never interpolated
  });

  it("treats a term that strips to nothing as no search (binds NULL)", async () => {
    const getAll = jest.fn().mockResolvedValue([]);
    setLocalReads(fakeReads({ getAll }));

    await listInventory(" %() , ");

    expect(getAll.mock.calls[0][1]).toEqual([null]);
  });

  it("never touches the local DB for a role outside the allow-list", async () => {
    const getAll = jest.fn().mockResolvedValue([]);
    setLocalReads(fakeReads({ getAll, role: () => "technician" as LocalRole }));

    const result = await listInventory();

    expect(getAll).not.toHaveBeenCalled(); // local rows would be silently empty
    expect(supabase.from as jest.Mock).toHaveBeenCalledWith("inventory"); // RLS stays the loud gate
    expect(result).toEqual([]);
  });
});
