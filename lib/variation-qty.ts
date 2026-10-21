// Custom / Other variations have no quantity (Justin, 21 Oct 2026: "when they
// select custom/other, can we please drop the quantity"). They are a one-off
// job priced as a lump sum: saved as quantity 1, and the office enters the
// price. Standard types keep their quantity (m³ of spoil, etc.).

export function isCustomVariation(v: { variation_type_id?: string | null }): boolean {
  return !v.variation_type_id;
}

/** "3 m³" — or "" for a custom variation logged without a quantity (1). */
export function variationQtyText(v: { variation_type_id?: string | null; quantity: number | string | null; unit?: string | null }): string {
  if (isCustomVariation(v) && Number(v.quantity) === 1) return "";
  return `${v.quantity ?? ""} ${v.unit ?? ""}`.trim();
}

/** The invoice line's description: "3 m³ @ $28.00", or "" for a custom lump sum. */
export function variationLineDescription(v: {
  variation_type_id?: string | null;
  quantity: number | string | null;
  unit?: string | null;
  rate?: number | string | null;
}): string {
  const qty = variationQtyText(v);
  if (!qty) return "";
  return `${qty}${v.rate != null ? ` @ $${Number(v.rate).toFixed(2)}` : ""}`;
}
