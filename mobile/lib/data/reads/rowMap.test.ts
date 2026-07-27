import { bool, groupByKey, nestOne, num, numOrNull } from "./rowMap";

describe("num", () => {
  it("passes numbers through and parses numeric strings", () => {
    expect(num(12.5)).toBe(12.5);
    expect(num("1234.50")).toBe(1234.5);
  });
  it("degrades junk to 0", () => {
    expect(num(null)).toBe(0);
    expect(num("")).toBe(0);
    expect(num("abc")).toBe(0);
  });
});

describe("numOrNull", () => {
  it("keeps null-ness — the app distinguishes 0 from unknown", () => {
    expect(numOrNull(null)).toBeNull();
    expect(numOrNull("")).toBeNull();
    expect(numOrNull("0")).toBe(0);
    expect(numOrNull(7)).toBe(7);
    expect(numOrNull("abc")).toBeNull();
  });
});

describe("bool", () => {
  it("maps SQLite integers to booleans", () => {
    expect(bool(1)).toBe(true);
    expect(bool(0)).toBe(false);
  });
  it("keeps null for nullable boolean columns", () => {
    expect(bool(null)).toBeNull();
    expect(bool(undefined)).toBeNull();
  });
});

describe("nestOne", () => {
  it("returns null when the FK is null — matching PostgREST's embed shape", () => {
    expect(nestOne(null, { name: null })).toBeNull();
  });
  it("returns the object when the FK is present", () => {
    expect(nestOne("uuid-1", { name: "Acme" })).toEqual({ name: "Acme" });
  });
});

describe("groupByKey", () => {
  it("groups child rows by foreign key preserving order", () => {
    const rows = [
      { device_id: "a", n: 1 },
      { device_id: "b", n: 2 },
      { device_id: "a", n: 3 },
    ];
    const g = groupByKey(rows, "device_id");
    expect(g.get("a")).toEqual([rows[0], rows[2]]);
    expect(g.get("b")).toEqual([rows[1]]);
    expect(g.get("c" as never)).toBeUndefined();
  });
});
