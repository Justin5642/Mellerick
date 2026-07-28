import { supabaseGateway } from "./gateway.supabase";

// The outbox replays writes, so a re-sent INSERT that already landed must count
// as success — otherwise a confirmed write dead-letters forever. That is why a
// unique_violation (23505) is swallowed.
//
// But NOT every 23505 is a replay. Two write targets carry a SECONDARY unique
// constraint on a column the app actually sends:
//   inventory.sku            (0000_baseline.sql:264)
//   variation_types.name     (0004_add_variations.sql:17)
// Creating a genuinely NEW item whose sku/name collides with a DIFFERENT row
// also raises 23505. Swallowing that reports success for a row that was never
// written: the outbox marks the op done and the record silently vanishes.
//
// So: swallow only when the PRIMARY KEY was violated (a true replay); surface
// everything else so the user is told their SKU is taken.

// `mock`-prefixed names are the only out-of-scope variables a hoisted
// jest.mock factory may reference.
const mockInsert = jest.fn();
const mockFrom = jest.fn(() => ({ insert: mockInsert }));

jest.mock("../supabase", () => ({ supabase: { from: () => mockFrom() } }));
jest.mock("expo-file-system/legacy", () => ({ readAsStringAsync: jest.fn(), EncodingType: { Base64: "base64" } }));
jest.mock("base64-arraybuffer", () => ({ decode: jest.fn() }));

const insert = mockInsert;

beforeEach(() => {
  mockInsert.mockReset();
  mockFrom.mockClear();
});

describe("insertRow — 23505 handling", () => {
  it("succeeds when the PRIMARY KEY collides (an outbox replay of a landed write)", async () => {
    insert.mockResolvedValue({
      error: { code: "23505", message: 'duplicate key value violates unique constraint "jobs_pkey"' },
    });
    await expect(supabaseGateway.insertRow("jobs", { id: "abc" })).resolves.toBeUndefined();
  });

  it("THROWS when a secondary unique constraint collides — the row was never written", async () => {
    insert.mockResolvedValue({
      error: { code: "23505", message: 'duplicate key value violates unique constraint "inventory_sku_key"' },
    });
    await expect(supabaseGateway.insertRow("inventory", { id: "new-1", sku: "TAKEN" })).rejects.toThrow(
      /inventory insert/
    );
  });

  it("throws on a duplicate variation_types.name rather than silently discarding it", async () => {
    insert.mockResolvedValue({
      error: { code: "23505", message: 'duplicate key value violates unique constraint "variation_types_name_key"' },
    });
    await expect(supabaseGateway.insertRow("variation_types", { id: "v1", name: "Excavation" })).rejects.toThrow(
      /variation_types insert/
    );
  });

  it("treats an unparseable 23505 as a replay — favouring the idempotent path over a stuck queue", async () => {
    // Defensive: if the constraint name is absent we cannot tell the cases apart.
    // Choosing "success" risks losing one row; choosing "throw" would dead-letter
    // a legitimately-replayed write forever. The former degrades better.
    insert.mockResolvedValue({ error: { code: "23505", message: "duplicate key value" } });
    await expect(supabaseGateway.insertRow("jobs", { id: "abc" })).resolves.toBeUndefined();
  });

  it("warns when it takes the unattributable path, so a silently-dropped row is traceable", async () => {
    // The ambiguous branch is the only place a write can vanish without an error.
    // It must leave a trace: a support call about a missing row is unanswerable
    // otherwise.
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    insert.mockResolvedValue({ error: { code: "23505", message: "duplicate key value" } });

    await supabaseGateway.insertRow("jobs", { id: "abc" });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("jobs"), "duplicate key value");
    warn.mockRestore();
  });

  it("does NOT warn on an attributable replay — that path is expected and benign", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    insert.mockResolvedValue({
      error: { code: "23505", message: 'duplicate key value violates unique constraint "jobs_pkey"' },
    });

    await supabaseGateway.insertRow("jobs", { id: "abc" });

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("still throws on non-unique-violation errors", async () => {
    insert.mockResolvedValue({ error: { code: "42703", message: 'column "nope" does not exist' } });
    await expect(supabaseGateway.insertRow("jobs", { id: "abc" })).rejects.toThrow(/jobs insert/);
  });

  it("succeeds on a clean insert", async () => {
    insert.mockResolvedValue({ error: null });
    await expect(supabaseGateway.insertRow("jobs", { id: "abc" })).resolves.toBeUndefined();
  });
});
