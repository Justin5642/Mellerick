import {
  fromLocalOr,
  markWritesSettled,
  onReadOrigin,
  resetSourceForTests,
  setLocalReads,
  type LocalReads,
  type LocalRole,
} from "./source";

function fakeReads(over: Partial<LocalReads> = {}): LocalReads {
  return {
    hasSynced: () => true,
    role: () => "office" as LocalRole,
    getAll: jest.fn().mockResolvedValue([]),
    getOptional: jest.fn().mockResolvedValue(null),
    ...over,
  };
}

const LOCAL = { from: "local" };
const REMOTE = { from: "remote" };

describe("fromLocalOr", () => {
  afterEach(() => resetSourceForTests());

  it("uses the remote path when no local source is registered", async () => {
    const remote = jest.fn().mockResolvedValue(REMOTE);
    await expect(fromLocalOr(async () => LOCAL, remote)).resolves.toBe(REMOTE);
    expect(remote).toHaveBeenCalled();
  });

  it("uses the remote path until first sync completes", async () => {
    setLocalReads(fakeReads({ hasSynced: () => false }));
    const remote = jest.fn().mockResolvedValue(REMOTE);
    await expect(fromLocalOr(async () => LOCAL, remote)).resolves.toBe(REMOTE);
  });

  it("uses the local path once registered and synced", async () => {
    setLocalReads(fakeReads());
    const local = jest.fn().mockResolvedValue(LOCAL);
    const remote = jest.fn();
    await expect(fromLocalOr(local, remote)).resolves.toBe(LOCAL);
    expect(remote).not.toHaveBeenCalled();
  });

  it("routes remote during the write-echo window, local after it closes", async () => {
    setLocalReads(fakeReads());
    const remote = jest.fn().mockResolvedValue(REMOTE);
    markWritesSettled(1_000); // echo until 6_000
    await expect(
      fromLocalOr(async () => LOCAL, remote, { now: () => 5_999 })
    ).resolves.toBe(REMOTE);
    await expect(
      fromLocalOr(async () => LOCAL, remote, { now: () => 6_000 })
    ).resolves.toBe(LOCAL);
  });

  it("routes remote for a role outside the allow-list — RLS must stay the loud gate", async () => {
    setLocalReads(fakeReads({ role: () => "technician" }));
    const local = jest.fn();
    const remote = jest.fn().mockResolvedValue(REMOTE);
    await expect(
      fromLocalOr(local, remote, { roles: ["office", "admin"] })
    ).resolves.toBe(REMOTE);
    expect(local).not.toHaveBeenCalled();
  });

  it("routes remote when the role is unknown", async () => {
    setLocalReads(fakeReads({ role: () => null }));
    const remote = jest.fn().mockResolvedValue(REMOTE);
    await expect(
      fromLocalOr(async () => LOCAL, remote, { roles: ["office"] })
    ).resolves.toBe(REMOTE);
  });

  it("falls back to remote when the local query throws", async () => {
    setLocalReads(fakeReads());
    const remote = jest.fn().mockResolvedValue(REMOTE);
    await expect(
      fromLocalOr(async () => {
        throw new Error("no such column: nope");
      }, remote)
    ).resolves.toBe(REMOTE);
  });

  it("reports origin and reason to listeners", async () => {
    const seen: unknown[] = [];
    onReadOrigin((origin, reason) => seen.push([origin, reason]));
    await fromLocalOr(async () => LOCAL, async () => REMOTE); // no local registered
    setLocalReads(fakeReads());
    await fromLocalOr(async () => LOCAL, async () => REMOTE);
    expect(seen).toEqual([
      ["remote", "no-local"],
      ["local", undefined],
    ]);
  });

  it("discards a local result when the mirror was torn down mid-query", async () => {
    const db = fakeReads();
    setLocalReads(db);
    const remote = jest.fn().mockResolvedValue(REMOTE);
    const local = jest.fn().mockImplementation(async () => {
      setLocalReads(null); // sign-out lands while the query is in flight
      return LOCAL; // rows from an emptied database
    });
    await expect(fromLocalOr(local, remote)).resolves.toBe(REMOTE);
    expect(remote).toHaveBeenCalled();
  });

  it("re-evaluates on every call: deregistering flips the next read to remote", async () => {
    setLocalReads(fakeReads());
    const remote = jest.fn().mockResolvedValue(REMOTE);
    await expect(fromLocalOr(async () => LOCAL, remote)).resolves.toBe(LOCAL);
    setLocalReads(null);
    await expect(fromLocalOr(async () => LOCAL, remote)).resolves.toBe(REMOTE);
  });
});
