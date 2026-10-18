// Sign-out removes this device's push-token row, so the office stops pushing
// one person's jobs to a phone they have left. Best-effort and bounded: it must
// never hold up a sign-out.

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

const mockUpsert = jest.fn();
const mockDeleteEq = jest.fn();
const mockRpc = jest.fn();
jest.mock("../supabase", () => ({
  supabase: {
    rpc: (...a: unknown[]) => mockRpc(...a),
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
  mockRpc.mockReset();
  // Default: a database without claim_device_token (one missing 0078).
  mockRpc.mockResolvedValue({ error: { code: "PGRST202", message: "not found" } });
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

  describe("shared phones (0078)", () => {
    it("claims the token through claim_device_token, so it follows whoever signs in", async () => {
      mockRpc.mockResolvedValue({ error: null });
      await expect(
        upsertDeviceToken({ token: "ExponentPushToken[shared]", platform: "android", userId: "u2" })
      ).resolves.toBe(true);
      expect(mockRpc).toHaveBeenCalledWith("claim_device_token", { p_token: "ExponentPushToken[shared]", p_platform: "android" });
      expect(mockUpsert).not.toHaveBeenCalled();
      expect(await AsyncStorage.getItem(REGISTERED_TOKEN_KEY)).toBe("ExponentPushToken[shared]");
    });

    it("falls back to the plain upsert only when the function does not exist yet", async () => {
      mockUpsert.mockResolvedValue({ error: null });
      await expect(upsertDeviceToken({ token: "ExponentPushToken[x]", platform: "ios", userId: "u1" })).resolves.toBe(true);
      expect(mockUpsert).toHaveBeenCalled();
    });

    it("does not fall back when the claim is refused for a real reason", async () => {
      mockRpc.mockResolvedValue({ error: { code: "42501", message: "account is not active" } });
      await expect(upsertDeviceToken({ token: "ExponentPushToken[x]", platform: "ios", userId: "u1" })).resolves.toBe(false);
      expect(mockUpsert).not.toHaveBeenCalled();
    });
  });
});
