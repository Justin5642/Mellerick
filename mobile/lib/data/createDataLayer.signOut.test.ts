import { createDataLayer } from "./createDataLayer";
import { InMemoryOutboxStore } from "./outbox/store";
import type { SupabaseGateway, ApiBridge } from "./gateway";
import type { Connectivity } from "./net/connectivity";

// The wired stack's half of sign-out: discarding one user's queued work and the
// staged files (job photos, receipts, signatures) that went with it.

function makeGateway(staged: string[]): jest.Mocked<SupabaseGateway> {
  return {
    insertRow: jest.fn().mockResolvedValue(undefined),
    updateRow: jest.fn().mockResolvedValue(undefined),
    deleteRow: jest.fn().mockResolvedValue(undefined),
    uploadObject: jest.fn().mockResolvedValue(undefined),
    removeObject: jest.fn().mockResolvedValue(undefined),
    cleanupAttachment: jest.fn().mockResolvedValue(undefined),
    listStagedAttachments: jest.fn().mockResolvedValue(staged.map((uri) => ({ uri, modifiedAt: Date.now() }))),
  };
}
const api: ApiBridge = { callSideEffect: jest.fn().mockResolvedValue(undefined) };
const offline: Connectivity = { isOnline: async () => false, onOnline: () => () => {} };

describe("DataLayer.clearLocalWorkFor", () => {
  it("removes the user's queued work and EVERY staged file no remaining op needs — even brand-new ones", async () => {
    const owner = { current: "alice" as string | null };
    const store = new InMemoryOutboxStore();
    const gw = makeGateway(["alice-photo.jpg", "bob-photo.jpg", "orphan.png"]);
    const layer = createDataLayer({ store, gateway: gw, api, connectivity: offline, owner: () => owner.current });

    await layer.outbox.enqueue({
      kind: "write", id: "a", rowId: "a", aggregate: "job_photo", op: "insert", table: "job_photos", payload: {},
      attachmentLocalPath: "alice-photo.jpg", status: "pending", attempts: 0, nextAttemptAt: 0, createdAt: 1,
    });
    owner.current = "bob";
    await layer.outbox.enqueue({
      kind: "write", id: "b", rowId: "b", aggregate: "job_photo", op: "insert", table: "job_photos", payload: {},
      attachmentLocalPath: "bob-photo.jpg", status: "pending", attempts: 0, nextAttemptAt: 0, createdAt: 2,
    });

    await layer.clearLocalWorkFor("alice");

    expect((await store.all()).map((o) => o.id)).toEqual(["b"]);
    // No grace period: the orphan sweep's would have kept these fresh files.
    expect(gw.cleanupAttachment.mock.calls.map((c) => c[0]).sort()).toEqual(["alice-photo.jpg", "orphan.png"]);
  });
});
