import { reconcileRows } from "./reconcile";

type Row = { id: string; v: string };

describe("reconcileRows", () => {
  it("lets the server row win for a shared id (optimistic replaced by real)", () => {
    const local: Row[] = [{ id: "a", v: "optimistic" }];
    const server: Row[] = [{ id: "a", v: "server" }];
    expect(reconcileRows(local, server, new Set(["a"]))).toEqual([{ id: "a", v: "server" }]);
  });

  it("keeps a local row that is absent from the server but still pending, leading the list", () => {
    const local: Row[] = [{ id: "new", v: "queued" }];
    const server: Row[] = [{ id: "old", v: "server" }];
    expect(reconcileRows(local, server, new Set(["new"]))).toEqual([
      { id: "new", v: "queued" }, // optimistic first
      { id: "old", v: "server" },
    ]);
  });

  it("drops a local row that is absent from the server and no longer pending (synced away or removed)", () => {
    const local: Row[] = [{ id: "gone", v: "stale" }];
    const server: Row[] = [{ id: "old", v: "server" }];
    expect(reconcileRows(local, server, new Set())).toEqual([{ id: "old", v: "server" }]);
  });

  it("never wipes a pending optimistic row when the server read is empty", () => {
    const local: Row[] = [{ id: "new", v: "queued" }];
    expect(reconcileRows(local, [], new Set(["new"]))).toEqual([{ id: "new", v: "queued" }]);
  });
});
