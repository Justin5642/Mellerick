// getOpenWorkEntry through both paths. The tracking gate keeps GPS on while
// this returns an entry, so the two paths must agree on what "open" means and
// return the same shape.
const mockCalls: { method: string; args: unknown[] }[] = [];
let mockAnswer: unknown = { data: [], error: null };

jest.mock("../../supabase", () => {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "order", "limit"]) {
    b[m] = (...args: unknown[]) => {
      mockCalls.push({ method: m, args });
      return b;
    };
  }
  b.then = (resolve: (v: unknown) => unknown) => resolve(mockAnswer);
  return { supabase: { from: (table: string) => (mockCalls.push({ method: "from", args: [table] }), b) } };
});

import { resetSourceForTests, setLocalReads, type LocalReads } from "./source";
import { getOpenWorkEntry, SQL_LATEST_OPEN_WORK_ENTRY } from "./clock";

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

afterEach(() => {
  resetSourceForTests();
  mockCalls.length = 0;
  mockAnswer = { data: [], error: null };
});

function fakeReads(row: { clock_in: string } | null): LocalReads & { getOptional: jest.Mock } {
  return {
    hasSynced: () => true,
    role: () => "technician",
    getAll: jest.fn(),
    getOptional: jest.fn().mockResolvedValue(row),
  } as unknown as LocalReads & { getOptional: jest.Mock };
}

describe("getOpenWorkEntry", () => {
  it("local: the latest open WORK entry for this staff member", async () => {
    const db = fakeReads({ clock_in: "2026-10-05T08:00:00Z" });
    setLocalReads(db);

    await expect(getOpenWorkEntry("tech-1")).resolves.toEqual({ clockInIso: "2026-10-05T08:00:00Z" });
    const [sql, params] = db.getOptional.mock.calls[0];
    expect(norm(sql)).toBe(
      norm(`SELECT clock_in FROM time_entries
            WHERE staff_id = ? AND entry_type = 'work' AND clock_out IS NULL
            ORDER BY clock_in DESC LIMIT 1`)
    );
    expect(sql).toBe(SQL_LATEST_OPEN_WORK_ENTRY);
    expect(params).toEqual(["tech-1"]);
    expect(mockCalls).toEqual([]);
  });

  it("local: null when nothing is open", async () => {
    setLocalReads(fakeReads(null));
    await expect(getOpenWorkEntry("tech-1")).resolves.toBeNull();
  });

  it("remote: the same filter, and the same shape", async () => {
    mockAnswer = { data: [{ clock_in: "2026-10-05T08:00:00Z" }], error: null };
    await expect(getOpenWorkEntry("tech-1")).resolves.toEqual({ clockInIso: "2026-10-05T08:00:00Z" });
    expect(mockCalls).toEqual([
      { method: "from", args: ["time_entries"] },
      { method: "select", args: ["clock_in"] },
      { method: "eq", args: ["staff_id", "tech-1"] },
      { method: "eq", args: ["entry_type", "work"] },
      { method: "is", args: ["clock_out", null] },
      { method: "order", args: ["clock_in", { ascending: false }] },
      { method: "limit", args: [1] },
    ]);
  });

  it("remote: null when nothing is open, and THROWS on failure so the gate can treat it as unknown", async () => {
    await expect(getOpenWorkEntry("tech-1")).resolves.toBeNull();
    mockAnswer = { data: null, error: { message: "offline", code: "0" } };
    await expect(getOpenWorkEntry("tech-1")).rejects.toThrow();
  });
});
