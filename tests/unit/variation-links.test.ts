import { describe, it, expect } from "vitest";
import { linkIndex, loadVariationLinks, variationLinkError, withLinkedVariation } from "@/lib/variation-links";

// The office's cost links to variations (variation_cost_links, 0120 — a draft).

function client(result: { data: unknown; error: { code?: string; message?: string } | null }) {
  const q: any = { select: () => q, in: () => Promise.resolve(result) };
  return { from: () => q };
}

describe("variation cost links", () => {
  it("a missing table (before 0120 is applied) is no links, not an error", async () => {
    const r = await loadVariationLinks(client({ data: null, error: { code: "42P01", message: "relation does not exist" } }), ["v1"]);
    expect(r).toEqual({ links: [], ready: false, error: null });
    const r2 = await loadVariationLinks(client({ data: null, error: { code: "PGRST205", message: "not in schema cache" } }), ["v1"]);
    expect(r2.ready).toBe(false);
  });

  it("any other failure is an error the ledger reports", async () => {
    const r = await loadVariationLinks(client({ data: null, error: { code: "57014", message: "timeout" } }), ["v1"]);
    expect(r.error).toBe("timeout");
  });

  it("tags each record with its variation, null when it has none", async () => {
    const { links } = await loadVariationLinks(
      client({ data: [{ id: "l1", variation_id: "v1", source: "job_expense", source_id: "e1" }], error: null }),
      ["v1"]
    );
    const tagged = withLinkedVariation([{ id: "e1", amount: 10 }, { id: "e2", amount: 5 }], "job_expense", linkIndex(links));
    expect(tagged.map((t) => t.variation_id)).toEqual(["v1", null]);
    // The same id under another source is not the linked record.
    expect(withLinkedVariation([{ id: "e1" }], "vendor_order", linkIndex(links))[0].variation_id).toBeNull();
  });

  it("answers refused writes with fixed sentences", () => {
    expect(variationLinkError({ code: "23505", message: "duplicate key value violates unique constraint" })).toMatch(/already linked/);
    expect(variationLinkError({ code: "23514", message: "That variation was rejected — costs can't go against it." })).toMatch(/rejected/);
    expect(variationLinkError({ code: "23514", message: "That cost isn't on this variation's job." })).toMatch(/isn't on this variation's job/);
    expect(variationLinkError({ code: "XX000", message: "internal: secret detail" })).toBe("Couldn't link that cost.");
  });
});
