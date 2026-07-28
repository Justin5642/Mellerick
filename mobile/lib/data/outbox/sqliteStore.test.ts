import { SqliteOutboxStore, __resetOutboxStoreForTests } from "./sqliteStore";

// Regression: "Cannot use shared object that was already released"
// (expo.modules.sqlite.NativeStatement), seen repeatedly on device.
//
// expo-sqlite returns a SHARED native object per database filename. Opening the
// same file twice therefore does not give you two independent connections — it
// gives you two JS handles onto one native object. When either is released (a
// Fast Refresh, a provider remount, React's dev double-mount), every other
// handle is left pointing at freed memory and the next query throws.
//
// DataProvider opens the store inside a useEffect, so ANY remount opened it a
// second time. The fix is to open once per process and hand the same instance to
// every caller.

const mockExecAsync = jest.fn();
const mockOpenDatabaseAsync = jest.fn();

jest.mock("expo-sqlite", () => ({
  openDatabaseAsync: (...args: unknown[]) => mockOpenDatabaseAsync(...args),
}));

beforeEach(() => {
  __resetOutboxStoreForTests();
  mockExecAsync.mockReset();
  mockOpenDatabaseAsync.mockReset();
  mockOpenDatabaseAsync.mockImplementation(async () => ({
    execAsync: mockExecAsync,
    runAsync: jest.fn(),
    getAllAsync: jest.fn(async () => []),
    getFirstAsync: jest.fn(async () => null),
  }));
});

describe("SqliteOutboxStore.open", () => {
  it("opens the underlying database exactly once across repeated calls", async () => {
    const a = await SqliteOutboxStore.open();
    const b = await SqliteOutboxStore.open();

    expect(mockOpenDatabaseAsync).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
  });

  it("does not re-open when two callers race (a provider remounting mid-open)", async () => {
    const [a, b] = await Promise.all([SqliteOutboxStore.open(), SqliteOutboxStore.open()]);

    expect(mockOpenDatabaseAsync).toHaveBeenCalledTimes(1);
    expect(b).toBe(a);
  });

  it("runs the schema DDL once, not once per caller", async () => {
    await SqliteOutboxStore.open();
    await SqliteOutboxStore.open();

    expect(mockExecAsync).toHaveBeenCalledTimes(1);
  });

  it("retries cleanly after a failed open rather than caching the rejection", async () => {
    mockOpenDatabaseAsync.mockRejectedValueOnce(new Error("disk full"));
    await expect(SqliteOutboxStore.open()).rejects.toThrow(/disk full/);

    // A cached rejected promise would make the outbox permanently unusable for
    // the rest of the process — the next attempt must be able to succeed.
    const store = await SqliteOutboxStore.open();
    expect(store).toBeInstanceOf(SqliteOutboxStore);
  });
});
