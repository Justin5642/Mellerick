import { supabase } from "../../supabase";

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

export async function listInventory(query?: string): Promise<InventoryItem[]> {
  let builder = supabase
    .from("inventory")
    .select("id, name, sku, description, category, unit, quantity_on_hand, reorder_level, unit_cost, unit_sell, supplier")
    .eq("is_active", true)
    .order("category")
    .order("name");
  const q = (query ?? "").replace(/[,()%]/g, " ").trim();
  if (q) builder = builder.or(`name.ilike.%${q}%,sku.ilike.%${q}%`);
  const { data } = await builder;
  return (data as unknown as InventoryItem[]) ?? [];
}
