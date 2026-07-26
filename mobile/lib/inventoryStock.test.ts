import { isLowStock, lowStockItems } from "./inventoryStock";

describe("isLowStock", () => {
  it("is true when quantity is at or below the reorder level (matches web)", () => {
    expect(isLowStock({ quantity_on_hand: 5, reorder_level: 10 })).toBe(true); // below
    expect(isLowStock({ quantity_on_hand: 10, reorder_level: 10 })).toBe(true); // at
    expect(isLowStock({ quantity_on_hand: 11, reorder_level: 10 })).toBe(false); // above
  });
});

describe("lowStockItems", () => {
  it("returns only the items needing reorder", () => {
    const items = [
      { id: "a", quantity_on_hand: 2, reorder_level: 5 },
      { id: "b", quantity_on_hand: 20, reorder_level: 5 },
      { id: "c", quantity_on_hand: 0, reorder_level: 0 },
    ];
    expect(lowStockItems(items).map((i) => i.id)).toEqual(["a", "c"]);
  });
});
