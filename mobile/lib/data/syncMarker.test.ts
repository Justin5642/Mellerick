jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

import AsyncStorage from "@react-native-async-storage/async-storage";
import { clearSyncMarker, decideColdStart, parseSyncMarker, readSyncMarker, writeSyncMarker } from "./syncMarker";

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe("decideColdStart", () => {
  it("serves the mirror at once only for the SAME user AND role that completed a full sync", () => {
    expect(decideColdStart({ userId: "u1", role: "technician" }, "u1", "technician")).toBe("serve-local");
  });

  it("keeps today's behaviour on a first-ever sync (no marker)", () => {
    expect(decideColdStart(null, "u1", "technician")).toBe("wait-for-sync");
  });

  it("wipes a mirror synced for another role — a demoted office user must not see invoice rows", () => {
    expect(decideColdStart({ userId: "u1", role: "office" }, "u1", "technician")).toBe("wipe");
  });

  it("wipes a mirror synced for another user", () => {
    expect(decideColdStart({ userId: "u2", role: "technician" }, "u1", "technician")).toBe("wipe");
  });
});

describe("marker storage", () => {
  it("round-trips, and clears", async () => {
    await writeSyncMarker({ userId: "u1", role: "admin" });
    expect(await readSyncMarker()).toEqual({ userId: "u1", role: "admin" });
    await clearSyncMarker();
    expect(await readSyncMarker()).toBeNull();
  });

  it("treats a malformed marker as absent (wait for sync, never trust it)", () => {
    expect(parseSyncMarker("nope")).toBeNull();
    expect(parseSyncMarker(JSON.stringify({ userId: "u1", role: "superuser" }))).toBeNull();
    expect(parseSyncMarker(JSON.stringify({ userId: "", role: "office" }))).toBeNull();
  });
});
