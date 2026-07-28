// Guards the two pieces of schema generation that can silently produce a wrong
// device schema: which columns a stream is understood to sync, and how a
// Postgres type is narrowed to one of SQLite's three.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseStreams, sqliteType, render } = require("./powersync-schema-lib.js");

describe("parseStreams", () => {
  it("collects the union of explicitly selected columns for a table", () => {
    const synced = parseStreams(`
streams:
  a:
    query: SELECT id, name FROM customers
  b:
    query: SELECT id, abn FROM customers
`);
    expect([...synced.get("customers")].sort()).toEqual(["abn", "id", "name"]);
  });

  it("treats SELECT * as the whole table, and it wins over a column list", () => {
    const synced = parseStreams(`
streams:
  tech:
    query: SELECT id, title FROM jobs WHERE assigned_to = auth.user_id()
  office:
    query: SELECT jobs.* FROM jobs JOIN profiles ON profiles.id = auth.user_id()
`);
    expect(synced.get("jobs")).toBe("ALL");
  });

  it("is order-independent: a column list after a star does not narrow the table", () => {
    const synced = parseStreams(`
streams:
  office:
    query: SELECT jobs.* FROM jobs
  tech:
    query: SELECT id, title FROM jobs
`);
    expect(synced.get("jobs")).toBe("ALL");
  });

  it("reads block-scalar queries and strips the table prefix from columns", () => {
    const synced = parseStreams(`
streams:
  tech_notes:
    auto_subscribe: true
    query: |
      SELECT job_notes.id, job_notes.content
      FROM job_notes
      WHERE job_id IN (SELECT id FROM jobs WHERE assigned_to = auth.user_id())
`);
    expect([...synced.get("job_notes")].sort()).toEqual(["content", "id"]);
  });

  it("attributes columns to the FROM table, not one named only in a subquery", () => {
    const synced = parseStreams(`
streams:
  tech_photos:
    query: |
      SELECT id, job_id FROM job_photos
      WHERE job_id IN (SELECT id FROM jobs WHERE assigned_to = auth.user_id())
`);
    expect(synced.has("job_photos")).toBe(true);
    expect(synced.has("jobs")).toBe(false);
  });
});

describe("sqliteType", () => {
  it("maps the integer family and boolean to integer (SQLite has no bool)", () => {
    expect(sqliteType("integer")).toBe("integer");
    expect(sqliteType("bigint")).toBe("integer");
    expect(sqliteType("smallint")).toBe("integer");
    expect(sqliteType("boolean")).toBe("integer");
  });

  it("maps numeric and floats to real so local reads match PostgREST's JSON numbers", () => {
    expect(sqliteType("numeric")).toBe("real");
    expect(sqliteType("double precision")).toBe("real");
    expect(sqliteType("real")).toBe("real");
  });

  it("falls back to text for uuid, timestamps and json", () => {
    for (const t of ["uuid", "text", "timestamp with time zone", "date", "jsonb", "ARRAY"]) {
      expect(sqliteType(t)).toBe("text");
    }
  });
});

describe("render", () => {
  const byTable = new Map([
    [
      "customers",
      [
        { name: "id", pg: "uuid" },
        { name: "name", pg: "text" },
        { name: "is_active", pg: "boolean" },
        { name: "secret_margin", pg: "numeric" },
      ],
    ],
  ]);

  it("omits the implicit id column and columns the streams do not select", () => {
    const out = render(new Map([["customers", new Set(["id", "name", "is_active"])]]), byTable);
    expect(out).toContain("name: column.text,");
    expect(out).toContain("is_active: column.integer,");
    expect(out).not.toContain("id: column.");
    expect(out).not.toContain("secret_margin");
  });

  it("fails loudly when a stream selects a column the database does not have", () => {
    expect(() => render(new Map([["customers", new Set(["nope"])]]), byTable)).toThrow(/unknown column/);
  });

  it("fails loudly when a streamed table is missing from the database", () => {
    expect(() => render(new Map([["ghosts", "ALL"]]), byTable)).toThrow(/not in the database/);
  });
});
