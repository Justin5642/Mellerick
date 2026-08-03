import { supabase } from "../../supabase";
import { fromLocalOr } from "./source";
import { num } from "./rowMap";
import { unwrapRows } from "./unwrap";

export interface InventoryItem {
  id: string;
  name: string;
  sku: string | null;
  description: string | null;
  category: string | null;
  unit: string | null;
  quantity_on_hand: number;
  reorder_level: number;
  unit_cost: number;
  unit_sell: number;
  supplier: string | null;
}

// Local (PowerSync) equivalent of the Supabase query below. `category` is
// nullable, so the `IS NULL` prefix reproduces Postgres' NULLS LAST default;
// COLLATE NOCASE approximates PG's case-insensitive collation.
export const SQL_LIST_INVENTORY = `
  SELECT id, name, sku, description, category, unit,
         quantity_on_hand, reorder_level, unit_cost, unit_sell, supplier
  FROM inventory
  WHERE is_active = 1
    AND (?1 IS NULL OR name LIKE '%'||?1||'%' OR sku LIKE '%'||?1||'%')
  ORDER BY category IS NULL, category COLLATE NOCASE, name COLLATE NOCASE`;

/** Row shape as the device SQLite returns it (numerics may arrive as strings). */
interface RawInventoryRow {
  id: string;
  name: string;
  sku: string | null;
  description: string | null;
  category: string | null;
  unit: string | null;
  quantity_on_hand: number | string | null;
  reorder_level: number | string | null;
  unit_cost: number | string | null;
  unit_sell: number | string | null;
  supplier: string | null;
}

function mapInventoryRow(r: RawInventoryRow): InventoryItem {
  return {
    id: r.id,
    name: r.name,
    sku: r.sku,
    description: r.description,
    category: r.category,
    unit: r.unit,
    quantity_on_hand: num(r.quantity_on_hand),
    reorder_level: num(r.reorder_level),
    unit_cost: num(r.unit_cost),
    unit_sell: num(r.unit_sell),
    supplier: r.supplier,
  };
}

export async function listInventory(query?: string): Promise<InventoryItem[]> {
  return fromLocalOr(
    async (db) => {
      // Same [,()%] stripping as the Supabase path. The term stays a BOUND
      // parameter — LIKE metacharacters %/_ are still active in SQLite, and
      // % is stripped here exactly as it is for the remote .or() filter.
      const q = (query ?? "").replace(/[,()%]/g, " ").trim();
      const rows = await db.getAll<RawInventoryRow>(SQL_LIST_INVENTORY, [q === "" ? null : q]);
      return rows.map(mapInventoryRow);
    },
    async () => {
      // ← unchanged pre-PowerSync Supabase body (byte-identical fallback).
      let builder = supabase
        .from("inventory")
        .select("id, name, sku, description, category, unit, quantity_on_hand, reorder_level, unit_cost, unit_sell, supplier")
        .eq("is_active", true)
        .order("category")
        .order("name");
      const q = (query ?? "").replace(/[,()%]/g, " ").trim();
      if (q) builder = builder.or(`name.ilike.%${q}%,sku.ilike.%${q}%`);
      const res = await builder;
      return unwrapRows(res as never, "listInventory") as unknown as InventoryItem[];
    },
    { roles: ["office", "admin"] }
  );
}
