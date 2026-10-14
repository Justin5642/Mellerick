import { describe, it, expect } from "vitest";
import { customerSearchFilters, customerSearchTokens } from "../../lib/customer-search";

// The Customers page and the customer picker both search in the database now,
// by building PostgREST or() filter strings from whatever was typed. A stray
// comma or parenthesis in the box must not be able to change the filter's
// structure (it would either 400 or match something else entirely).

describe("customerSearchTokens", () => {
  it("splits on whitespace and drops empties", () => {
    expect(customerSearchTokens("  smith   acme ")).toEqual(["smith", "acme"]);
    expect(customerSearchTokens("   ")).toEqual([]);
  });

  it("strips characters that are syntax in an or() filter", () => {
    expect(customerSearchTokens('a,b (c) d%e*f\\g"h')).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
  });
});

describe("customerSearchFilters", () => {
  it("builds one or() per word across every column", () => {
    expect(customerSearchFilters("jo 0412", ["name", "email"])).toEqual([
      "name.ilike.%jo%,email.ilike.%jo%",
      "name.ilike.%0412%,email.ilike.%0412%",
    ]);
  });

  it("returns no filters for an empty search", () => {
    expect(customerSearchFilters("", ["name"])).toEqual([]);
  });
});
