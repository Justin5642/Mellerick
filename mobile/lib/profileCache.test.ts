jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  clearCachedProfile,
  decideProfileResult,
  parseCachedProfile,
  profileCacheKey,
  readCachedProfile,
  toCachedProfile,
  writeCachedProfile,
  type CachedProfile,
} from "./profileCache";

const TECH: CachedProfile = { id: "u1", full_name: "Jake H", email: "j@x", role: "technician", is_active: true };

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe("profile cache storage", () => {
  it("round-trips the signed-in user's profile", async () => {
    await writeCachedProfile(TECH);
    expect(await readCachedProfile("u1")).toEqual(TECH);
  });

  it("never answers for a different user", async () => {
    await writeCachedProfile(TECH);
    expect(await readCachedProfile("u2")).toBeNull();
  });

  it("rejects a record whose stored user id does not match its key (no cross-user reuse)", async () => {
    // A record for u1 planted under u2's key must not be served to u2.
    await AsyncStorage.setItem(profileCacheKey("u2"), JSON.stringify({ v: 1, userId: "u1", profile: TECH }));
    expect(await readCachedProfile("u2")).toBeNull();
    // ...nor one whose embedded profile id disagrees with the record's user id.
    await AsyncStorage.setItem(
      profileCacheKey("u3"),
      JSON.stringify({ v: 1, userId: "u3", profile: { ...TECH, id: "u1" } })
    );
    expect(await readCachedProfile("u3")).toBeNull();
  });

  it("treats corrupt or old-format records as a miss", () => {
    expect(parseCachedProfile("{not json", "u1")).toBeNull();
    expect(parseCachedProfile(JSON.stringify({ userId: "u1", profile: TECH }), "u1")).toBeNull(); // no version
    expect(parseCachedProfile(null, "u1")).toBeNull();
  });

  it("stores only the gating fields, never extra profile columns", async () => {
    const row = { ...TECH, phone: "0400 000 000", hourly_rate: 95 };
    const picked = toCachedProfile(row)!;
    await writeCachedProfile(picked);
    const raw = await AsyncStorage.getItem(profileCacheKey("u1"));
    expect(raw).not.toContain("hourly_rate");
    expect(raw).not.toContain("0400");
  });

  it("treats a missing is_active as inactive (fail closed)", () => {
    expect(toCachedProfile({ id: "u1", role: "technician" })!.is_active).toBe(false);
  });

  it("clears one user's entry, or every cached profile", async () => {
    await writeCachedProfile(TECH);
    await writeCachedProfile({ ...TECH, id: "u2" });
    await AsyncStorage.setItem("unrelated", "keep");
    await clearCachedProfile("u1");
    expect(await readCachedProfile("u1")).toBeNull();
    expect(await readCachedProfile("u2")).not.toBeNull();
    await clearCachedProfile();
    expect(await readCachedProfile("u2")).toBeNull();
    expect(await AsyncStorage.getItem("unrelated")).toBe("keep");
  });
});

describe("decideProfileResult — the server always wins once it answers", () => {
  it("applies a fresh server profile over a cached one, including a changed role", () => {
    const fresh = { ...TECH, role: "office" };
    expect(decideProfileResult({ shown: TECH, data: fresh, error: null })).toEqual({ kind: "apply", profile: fresh });
  });

  it("applies a deactivation the server reports", () => {
    const d = decideProfileResult({ shown: TECH, data: { ...TECH, is_active: false }, error: null });
    expect(d).toEqual({ kind: "apply", profile: { ...TECH, is_active: false } });
  });

  it("clears on a definitive 'no profile row' (PGRST116), even with a cached profile shown", () => {
    expect(decideProfileResult({ shown: TECH, data: null, error: { code: "PGRST116", message: "0 rows" } })).toEqual({
      kind: "clear",
    });
  });

  it("keeps what is shown on a transient failure (offline cold start over the cache)", () => {
    expect(decideProfileResult({ shown: TECH, data: null, error: { message: "Network request failed" } })).toEqual({
      kind: "keep",
    });
  });

  it("reports an error when nothing is shown and the read failed", () => {
    const error = { message: "timeout" };
    expect(decideProfileResult({ shown: null, data: null, error })).toEqual({ kind: "error", error });
  });
});
