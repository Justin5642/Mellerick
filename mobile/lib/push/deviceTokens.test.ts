// Sign-out removes this device's push-token row, so the office stops pushing
// one person's jobs to a phone they have left. Best-effort and bounded: it must
// never hold up a sign-out.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

const mockUpsert = jest.fn();
const mockDeleteEq = jest.fn();
jest.mock("../supabase", () => ({
  supabase: {
    from: () => ({
      upsert: (...a: unknown[]) => mockUpsert(...a),
      delete: () => ({ eq: (...a: unknown[]) => mockDeleteEq(...a) }),
    }),
  },
}));

import AsyncStorage from "@react-native-async-storage/async-storage";
import { REGISTERED_TOKEN_KEY, removeDeviceToken, upsertDeviceToken } from "./deviceTokens";

beforeEach(async () => {
  await AsyncStorage.clear();
  mockUpsert.mockReset();
  mockDeleteEq.mockReset();
  jest.useRealTimers();
});

describe("device push tokens", () => {
  it("remembers the token it registered, and deletes exactly that row at sign-out", async () => {
    mockUpsert.mockResolvedValue({ error: null });
    mockDeleteEq.mockResolvedValue({ error: null });
    await upsertDeviceToken({ token: "ExponentPushToken[abc]", platform: "ios", userId: "u1" });
    expect(await AsyncStorage.getItem(REGISTERED_TOKEN_KEY)).toBe("ExponentPushToken[abc]");

    await expect(removeDeviceToken()).resolves.toBe(true);
    expect(mockDeleteEq).toHaveBeenCalledWith("token", "ExponentPushToken[abc]");
    expect(await AsyncStorage.getItem(REGISTERED_TOKEN_KEY)).toBeNull();
  });

  it("does nothing when this device never registered", async () => {
    await expect(removeDeviceToken()).resolves.toBe(true);
    expect(mockDeleteEq).not.toHaveBeenCalled();
  });

  it("reports (does not throw) when the server refuses", async () => {
    await AsyncStorage.setItem(REGISTERED_TOKEN_KEY, "t");
    mockDeleteEq.mockResolvedValue({ error: { message: "nope" } });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    await expect(removeDeviceToken()).resolves.toBe(false);
    warn.mockRestore();
  });

  it("gives up after a few seconds offline rather than holding up sign-out", async () => {
    jest.useFakeTimers();
    await AsyncStorage.setItem(REGISTERED_TOKEN_KEY, "t");
    mockDeleteEq.mockReturnValue(new Promise(() => {})); // never answers
    const pending = removeDeviceToken();
    await jest.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toBe(false);
  });
});
