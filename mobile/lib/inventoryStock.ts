// Low-stock rule, mirroring the web inventory page: an item needs reordering
// when its quantity on hand is AT OR BELOW its reorder level.
export interface StockItem {
  quantity_on_hand: number;
  reorder_level: number;
}

export function isLowStock(item: StockItem): boolean {
  return Number(item.quantity_on_hand) <= Number(item.reorder_level);
}

export function lowStockItems<T extends StockItem>(items: T[]): T[] {
  return items.filter(isLowStock);
}
