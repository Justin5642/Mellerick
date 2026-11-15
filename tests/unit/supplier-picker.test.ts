import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { groupSuppliers, recentSupplierIds, supplierMatchRank, type PickerSupplier, type SupplierUse } from "@/lib/supplier-picker";

const S = (id: string, name: string, pinOrder: number | null = null): PickerSupplier => ({ id, name, pinOrder });

const list: PickerSupplier[] = [
  S("reece", "Reece Epping", 1),
  S("coop", "Plumbers Co-op", 2),
  S("nq", "Northern Quarries", 3),
  S("boral", "Boral", 4),
  S("tradelink", "Tradelink"),
  S("bunnings", "Bunnings"),
  S("abc", "ABC Pipes"),
  S("zeta", "Zeta Hire"),
  S("mpa", "MPA Supplies"),
];

const ids = (g: { suppliers: PickerSupplier[] }) => g.suppliers.map((s) => s.id);

describe("groupSuppliers — the picker's groups", () => {
  it("puts the pinned ones first, in pin order", () => {
    const shuffled = [list[3], list[1], list[0], list[2], ...list.slice(4)];
    const [pinned] = groupSuppliers(shuffled);
    expect(pinned.key).toBe("pinned");
    expect(pinned.label).toBe("Pinned");
    expect(ids(pinned)).toEqual(["reece", "coop", "nq", "boral"]);
  });

  it("lists recent ones next, most recent first, skipping any already pinned", () => {
    const groups = groupSuppliers(list, { recentIds: ["tradelink", "reece", "zeta", "boral", "abc"] });
    expect(groups.map((g) => g.key)).toEqual(["pinned", "recent", "all"]);
    expect(ids(groups[1])).toEqual(["tradelink", "zeta", "abc"]);
  });

  it("keeps the recent group to the limit after the pinned are taken out", () => {
    const groups = groupSuppliers(list, { recentIds: ["reece", "tradelink", "zeta", "abc", "mpa"], recentLimit: 3 });
    expect(ids(groups[1])).toEqual(["tradelink", "zeta", "abc"]);
    // The one that didn't fit is still in All.
    expect(ids(groups[2])).toContain("mpa");
  });

  it("lists everyone else A–Z, nobody twice", () => {
    const groups = groupSuppliers(list, { recentIds: ["zeta"] });
    expect(ids(groups[2])).toEqual(["abc", "bunnings", "mpa", "tradelink"]);
    const all = groups.flatMap((g) => ids(g));
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(list.length);
  });

  it("leaves out empty groups — nothing pinned and no recent is one A–Z list", () => {
    const plain = list.map((s) => ({ ...s, pinOrder: null }));
    const groups = groupSuppliers(plain, { recentIds: [] });
    expect(groups.map((g) => g.key)).toEqual(["all"]);
    expect(ids(groups[0])[0]).toBe("abc");
  });

  it("ignores recent ids that aren't on the list (inactive or removed)", () => {
    const groups = groupSuppliers(list, { recentIds: ["gone", "abc"] });
    expect(ids(groups[1])).toEqual(["abc"]);
  });

  it("works with no pin order at all (a server before 0097)", () => {
    const old = list.map(({ id, name }) => ({ id, name }));
    const groups = groupSuppliers(old, { recentIds: ["boral"] });
    expect(groups.map((g) => g.key)).toEqual(["recent", "all"]);
    expect(ids(groups[0])).toEqual(["boral"]);
  });
});

describe("groupSuppliers — search", () => {
  it("filters across every group", () => {
    const groups = groupSuppliers(
      [...list, S("reece2", "Reece Thomastown"), S("bor2", "Boral Quarries Deer Park")],
      { recentIds: ["reece2"], query: "reec" }
    );
    // Reece Epping (pinned), Reece Thomastown (recent); nothing in All matches.
    expect(groups.map((g) => [g.key, ids(g)])).toEqual([
      ["pinned", ["reece"]],
      ["recent", ["reece2"]],
    ]);
  });

  it("finds a supplier wherever it sits, by any word", () => {
    const groups = groupSuppliers(list, { recentIds: ["zeta"], query: "quarr" });
    expect(groups.map((g) => [g.key, ids(g)])).toEqual([["pinned", ["nq"]]]);
    const hire = groupSuppliers(list, { recentIds: ["zeta"], query: "hire" });
    expect(hire.map((g) => [g.key, ids(g)])).toEqual([["recent", ["zeta"]]]);
  });

  it("puts the best matches first in All", () => {
    const more = [S("a", "Supply Co"), S("b", "MPA Supplies"), S("c", "Wholesupply")];
    const [all] = groupSuppliers(more, { query: "supp" });
    expect(ids(all)).toEqual(["a", "b", "c"]);
  });

  it("ignores case, spaces at the ends and punctuation", () => {
    expect(ids(groupSuppliers(list, { query: "  COOP " })[0])).toEqual(["coop"]);
    expect(ids(groupSuppliers(list, { query: "co-op" })[0])).toEqual(["coop"]);
  });

  it("returns nothing when nothing matches", () => {
    expect(groupSuppliers(list, { recentIds: ["zeta"], query: "xyz" })).toEqual([]);
  });

  it("ranks matches", () => {
    expect(supplierMatchRank("Reece Epping", "reece")).toBe(3);
    expect(supplierMatchRank("Reece Epping", "epp")).toBe(2);
    expect(supplierMatchRank("Plumbers Co-op", "rsco")).toBe(1);
    expect(supplierMatchRank("Plumbers Co-op", "boral")).toBe(0);
  });
});

describe("recentSupplierIds — worked out from past POs", () => {
  const use = (supplierId: string | null, enteredBy: string | null, createdAt: string, vendorName: string | null = null): SupplierUse => ({
    supplierId,
    vendorName,
    enteredBy,
    createdAt,
  });

  it("is most recent first, each supplier once", () => {
    const uses = [
      use("abc", "u2", "2026-11-01T00:00:00Z"),
      use("zeta", "u2", "2026-11-03T00:00:00Z"),
      use("abc", "u2", "2026-11-05T00:00:00Z"),
    ];
    expect(recentSupplierIds(uses, list, null)).toEqual(["abc", "zeta"]);
  });

  it("puts the caller's own POs before the rest of the company's", () => {
    const uses = [
      use("zeta", "someone-else", "2026-11-09T00:00:00Z"),
      use("abc", "me", "2026-11-01T00:00:00Z"),
      use("mpa", "me", "2026-11-02T00:00:00Z"),
      use("abc", "someone-else", "2026-11-08T00:00:00Z"),
    ];
    expect(recentSupplierIds(uses, list, "me")).toEqual(["mpa", "abc", "zeta"]);
  });

  it("counts an order typed in by name when the name is on the list", () => {
    const uses = [use(null, "me", "2026-11-02T00:00:00Z", "  tradelink "), use(null, "me", "2026-11-03T00:00:00Z", "Some One-off")];
    expect(recentSupplierIds(uses, list, "me")).toEqual(["tradelink"]);
  });

  it("skips suppliers no longer on the list", () => {
    const uses = [use("gone", "me", "2026-11-05T00:00:00Z", "Tradelink"), use("abc", "me", "2026-11-01T00:00:00Z")];
    expect(recentSupplierIds(uses, list, "me")).toEqual(["abc"]);
  });

  it("stops at the limit", () => {
    const uses = ["abc", "zeta", "mpa", "tradelink"].map((id, i) => use(id, "me", `2026-11-0${9 - i}T00:00:00Z`));
    expect(recentSupplierIds(uses, list, "me", 2)).toEqual(["abc", "zeta"]);
  });

  it("feeds groupSuppliers so pinned ones still don't show twice", () => {
    const uses = [use("reece", "me", "2026-11-09T00:00:00Z"), use("abc", "me", "2026-11-08T00:00:00Z")];
    const groups = groupSuppliers(list, { recentIds: recentSupplierIds(uses, list, "me") });
    expect(ids(groups[1])).toEqual(["abc"]);
  });
});

describe("lib/supplier-picker.ts and mobile/lib/supplierPicker.ts", () => {
  it("are identical apart from comments", () => {
    const body = (f: string) => readFileSync(f, "utf8").replace(/^\/\/.*$/gm, "").trim();
    expect(body("mobile/lib/supplierPicker.ts")).toBe(body("lib/supplier-picker.ts"));
  });
});
