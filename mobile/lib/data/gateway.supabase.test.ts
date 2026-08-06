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
const mockUpdateResult = jest.fn();
const mockDeleteResult = jest.fn();

// update/delete are chained: .update(patch).eq("id", id). The eq() resolves.
const mockUpdate = jest.fn(() => ({ eq: () => mockUpdateResult() }));
const mockDelete = jest.fn(() => ({ eq: () => mockDeleteResult() }));

const mockFrom = jest.fn(() => ({ insert: mockInsert, update: mockUpdate, delete: mockDelete }));

jest.mock("../supabase", () => ({ supabase: { from: () => mockFrom() } }));
jest.mock("expo-file-system/legacy", () => ({ readAsStringAsync: jest.fn(), EncodingType: { Base64: "base64" } }));
jest.mock("base64-arraybuffer", () => ({ decode: jest.fn() }));

const insert = mockInsert;

beforeEach(() => {
  mockInsert.mockReset();
  mockUpdateResult.mockReset();
  mockDeleteResult.mockReset();
  mockFrom.mockClear();
});

// ---------------------------------------------------------------------------
// A WRITE THAT AFFECTED NO ROWS IS NOT A WRITE.
//
// updateRow checked only `error`. PostgREST does not return an error when an
// UPDATE matches nothing — RLS filters the row out and the statement succeeds
// against zero rows. So a technician's edit that RLS denied, or one targeting a
// row that is not theirs, came back clean; the processor marked the operation
// done and deleted it from the outbox. No error, no dead letter, no badge. The
// edit simply never happened.
//
// This is the same shape as the geofence and clock-in defects: the code asked
// "did it fail?" when the question was "did it happen?".
//
// DELETE is deliberately NOT symmetric. Zero rows there means the row is already
// gone, which for an idempotent replay is success, not loss.
// ---------------------------------------------------------------------------
describe("updateRow — a write that changed nothing must not report success", () => {
  it("throws when the update matched no rows", async () => {
    mockUpdateResult.mockResolvedValue({ error: null, count: 0 });
    await expect(supabaseGateway.updateRow("time_entries", "row-1", { hours: 2 })).rejects.toThrow(
      /affected no rows/i
    );
  });

  it("names the table and row, because the outbox replays many of these", async () => {
    mockUpdateResult.mockResolvedValue({ error: null, count: 0 });
    await expect(supabaseGateway.updateRow("job_photos", "photo-9", { caption: "x" })).rejects.toThrow(
      /job_photos.*photo-9|photo-9.*job_photos/
    );
  });

  it("succeeds when a row was actually updated", async () => {
    mockUpdateResult.mockResolvedValue({ error: null, count: 1 });
    await expect(supabaseGateway.updateRow("time_entries", "row-1", { hours: 2 })).resolves.toBeUndefined();
  });

  it("still surfaces a genuine error", async () => {
    mockUpdateResult.mockResolvedValue({ error: { message: "permission denied" }, count: null });
    await expect(supabaseGateway.updateRow("time_entries", "row-1", { hours: 2 })).rejects.toThrow(
      /permission denied/
    );
  });

  it("does not fail when the driver reports no count at all", async () => {
    // Some PostgREST configurations omit the count header. Treating an ABSENT
    // count as zero would dead-letter every healthy write — worse than the bug
    // being fixed. Absence is unknown, and unknown is not failure.
    mockUpdateResult.mockResolvedValue({ error: null, count: null });
    await expect(supabaseGateway.updateRow("time_entries", "row-1", { hours: 2 })).resolves.toBeUndefined();
  });
});

describe("deleteRow — zero rows is success, not loss", () => {
  it("succeeds when the row is already gone (an idempotent replay)", async () => {
    mockDeleteResult.mockResolvedValue({ error: null, count: 0 });
    await expect(supabaseGateway.deleteRow("job_photos", "photo-1")).resolves.toBeUndefined();
  });

  it("still surfaces a genuine error", async () => {
    mockDeleteResult.mockResolvedValue({ error: { message: "boom" }, count: null });
    await expect(supabaseGateway.deleteRow("job_photos", "photo-1")).rejects.toThrow(/boom/);
  });
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
