import { act, render, waitFor } from "@testing-library/react-native";
import { Text } from "react-native";

// What auth-context's signOut must do beyond ending the session, and the
// outbox owner it publishes. (The unsynced-work warning and the outbox wipe
// sit one layer up — lib/signOutFlow.test.ts.)

jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

const mockOrder: string[] = [];
const mockGetSession = jest.fn(() => Promise.resolve({ data: { session: { user: { id: "user-1" } } } }));

jest.mock("./supabase", () => ({
  supabase: {
    auth: {
      getSession: () => mockGetSession(),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: jest.fn() } } }),
      signOut: jest.fn(async () => {
        mockOrder.push("auth.signOut");
        return { error: null };
      }),
    },
    from: () => ({
      select: () => ({ eq: () => ({ single: async () => ({ data: null, error: { code: "PGRST116", message: "none" } }) }) }),
    }),
  },
}));
jest.mock("./push/deviceTokens", () => ({
  removeDeviceToken: jest.fn(async () => {
    mockOrder.push("removeDeviceToken");
    return true;
  }),
}));
jest.mock("./imageCache", () => ({
  clearImageCaches: jest.fn(async () => {
    mockOrder.push("clearImageCaches");
  }),
}));

import { AuthProvider, useAuth } from "./auth-context";
import { getOutboxOwner, setOutboxOwner } from "./data/outboxOwner";

let captured: ReturnType<typeof useAuth> | null = null;
function Probe() {
  captured = useAuth();
  return <Text>probe</Text>;
}

beforeEach(() => {
  mockOrder.length = 0;
  setOutboxOwner(null);
});

describe("AuthProvider.signOut", () => {
  it("removes this device's push token BEFORE the session ends, and clears image caches after", async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(captured?.loading).toBe(false));
    await act(async () => {
      await captured!.signOut();
    });
    // The token row is deletable only by its owner, so after auth.signOut it
    // could no longer be removed.
    expect(mockOrder).toEqual(["removeDeviceToken", "auth.signOut", "clearImageCaches"]);
  });

  it("publishes the signed-in user as the outbox owner", async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => expect(getOutboxOwner()).toBe("user-1"));
  });
});
