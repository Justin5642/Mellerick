// The money-contract guard over the sync configuration itself.
//
// Two sources are checked against each other and against an explicit
// allow-list:
//   1. mobile/powersync/sync-streams.yaml (what the service is told to sync)
//   2. mobile/lib/powersync/schema.ts     (what the device can store)
//
// If someone adds a money column to a technician stream, or the generated
// schema drifts from the streams file, this suite fails before any device
// ever syncs it.
import { readFileSync } from "fs";
import { join } from "path";
import { AppSchema } from "./schema";

const { parseStreams } = require("../../scripts/powersync-schema-lib.js");

const MONEY_COLUMNS = new Set([
  "rate",
  "total",
  "total_amount",
  "total_value",
  "subtotal",
  "amount",
  "amount_paid",
  "gst_amount",
  "tax_amount",
  "unit_price",
  "unit_cost",
  "unit_sell",
  "allocated_amount",
  "purchase_cost",
  "insurance_annual",
  "maintenance_annual",
  "registration_annual",
  "other_annual_costs",
  "fuel_cost_per_hour",
  "hourly_rate",
  "charge_out_rate",
  "min_margin_pct",
  "rate_override",
  "admin_notes",
]);

const yaml = readFileSync(join(__dirname, "..", "..", "powersync", "sync-streams.yaml"), "utf8");

// Streams a technician receives rows from: everything not office-gated.
// The office streams all carry the JOIN-on-profiles role gate.
function techVisibleColumns(): Map<string, Set<string> | "ALL"> {
  const queries = [...yaml.matchAll(/^\s{2}(\w+):\n(?:\s{4}.*\n)*?\s{4}query:\s*(\|?)([^]*?)(?=\n\s{2}\w+:|\n*$)/gm)];
  void queries; // parseStreams handles extraction; here we only need the split below.
  const [header] = yaml.split(/# ---- Office\/admin/);
  return parseStreams(header);
}

describe("technician streams", () => {
  const tech = techVisibleColumns();

  it("cover only the expected tables", () => {
    expect([...tech.keys()].sort()).toEqual([
      "backflow_devices",
      "backflow_tests",
      "customers",
      "job_notes",
      "job_photos",
      "job_variations",
      "jobs",
      "profiles",
      "sites",
      "time_entries",
      "variation_types",
    ]);
  });

  it("select no money column anywhere", () => {
    for (const [table, cols] of tech) {
      if (cols === "ALL") {
        // Whole-table tech syncs are only legal for tables with zero money
        // columns; backflow tables are the only sanctioned cases.
        expect(["backflow_devices", "backflow_tests"]).toContain(table);
        continue;
      }
      for (const c of cols) {
        expect({ table, column: c, isMoney: MONEY_COLUMNS.has(c) }).toEqual({
          table,
          column: c,
          isMoney: false,
        });
      }
    }
  });

  it("keep job_variations rate-stripped (rate, total_amount, admin_notes omitted)", () => {
    const cols = tech.get("job_variations");
    expect(cols).not.toBe("ALL");
    for (const banned of ["rate", "total_amount", "admin_notes"]) {
      expect((cols as Set<string>).has(banned)).toBe(false);
    }
  });

  it("keep variation_types rate-stripped", () => {
    const cols = tech.get("variation_types");
    expect((cols as Set<string>).has("rate")).toBe(false);
  });
});

describe("generated device schema", () => {
  const streams = parseStreams(yaml) as Map<string, Set<string> | "ALL">;
  const schemaTables = new Map(AppSchema.tables.map((t) => [t.name, t.columns.map((c) => c.name)]));

  it("has exactly the streamed tables", () => {
    expect([...schemaTables.keys()].sort()).toEqual([...streams.keys()].sort());
  });

  it("has exactly the streamed columns for column-listed tables", () => {
    for (const [table, cols] of streams) {
      if (cols === "ALL") continue;
      const expected = [...cols].filter((c) => c !== "id").sort();
      expect({ table, columns: [...(schemaTables.get(table) ?? [])].sort() }).toEqual({
        table,
        columns: expected,
      });
    }
  });
});
