import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Pressable, Text } from "react-native";

// ============================================================================
// A failed profile read must not be reported as "your account has no role".
//
// Found by the audit pass over the floating-promise campaign, not by a test —
// which is why this file exists now.
//
// `profile` is null in two completely different situations: the read broke, and
// the account genuinely has no role assigned. app/_layout.tsx can only branch
// on what the context gives it, so with a single null it rendered the
// fail-closed screen for both:
//
//     "No role assigned — Your account has no access role yet.
//      Please contact your administrator."
//
// A technician whose request timed out is told a fact about their account. They
// ring the office about permissions; the office has nothing to fix; nobody
// retries. It is the same defect as an empty list that means "the query
// failed" — an absence presented as an answer — and the whole campaign this
// came out of exists to remove exactly that.
//
// So the context now distinguishes them with `profileError`, and these tests
// pin the distinction rather than the wording of any screen.
// ============================================================================

const mockSingle = jest.fn();
const mockGetSession = jest.fn((..._a: unknown[]): Promise<{ data: { session: unknown } }> =>
  Promise.resolve({ data: { session: null } })
);
const mockOnAuthStateChange = jest.fn((..._a: unknown[]) => ({ data: { subscription: { unsubscribe: jest.fn() } } }));

jest.mock("./supabase", () => ({
  supabase: {
    auth: {
      getSession: (...a: unknown[]) => mockGetSession(...a),
      onAuthStateChange: (...a: unknown[]) => mockOnAuthStateChange(...a),
      signInWithPassword: jest.fn(),
      signOut: jest.fn(),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => mockSingle(),
        }),
      }),
    }),
  },
}));

import { AuthProvider, useAuth } from "./auth-context";

const SESSION = { user: { id: "user-1" } };

/** Renders the three pieces of state a consumer branches on. */
function Probe() {
  const { profile, loading, profileError, reloadProfile } = useAuth();
  return (
    <>
      <Text testID="loading">{String(loading)}</Text>
      <Text testID="profile">{profile ? "present" : "null"}</Text>
      <Text testID="error">{profileError ? "error" : "none"}</Text>
      <Pressable testID="retry" onPress={reloadProfile}>
        <Text>retry</Text>
      </Pressable>
    </>
  );
}

const renderAuth = () =>
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>
  );

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSession.mockResolvedValue({ data: { session: SESSION } });
});

describe("a profile read that FAILS is distinguishable from an account with no role", () => {
  it("reports an error when the read returns one and nothing is cached", async () => {
    mockSingle.mockResolvedValue({ data: null, error: { message: "network request failed" } });

    renderAuth();

    await waitFor(() => expect(screen.getByTestId("loading").props.children).toBe("false"));
    // THE POINT: profile is null either way, so a consumer that only sees
    // `profile` cannot tell these apart. `profileError` is what lets it.
    expect(screen.getByTestId("profile").props.children).toBe("null");
    expect(screen.getByTestId("error").props.children).toBe("error");
  });

  it("reports an error when the read THROWS and nothing is cached", async () => {
    mockSingle.mockRejectedValue(new Error("Network request failed"));

    renderAuth();

    await waitFor(() => expect(screen.getByTestId("loading").props.children).toBe("false"));
    expect(screen.getByTestId("error").props.children).toBe("error");
  });

  it("reports NO error for an account that legitimately has no role", async () => {
    // The negative control, and the reason the two must stay separate: a real
    // roleless account has to keep reaching the fail-closed screen. If this
    // ever reports an error, the fix has replaced one wrong screen with
    // another.
    mockSingle.mockResolvedValue({ data: { id: "user-1", role: null }, error: null });

    renderAuth();

    await waitFor(() => expect(screen.getByTestId("loading").props.children).toBe("false"));
    expect(screen.getByTestId("profile").props.children).toBe("present");
    expect(screen.getByTestId("error").props.children).toBe("none");
  });

  it("clears a previous error once a read succeeds", async () => {
    mockSingle
      .mockResolvedValueOnce({ data: null, error: { message: "boom" } })
      .mockResolvedValue({ data: { id: "user-1", role: "technician" }, error: null });

    renderAuth();
    await waitFor(() => expect(screen.getByTestId("error").props.children).toBe("error"));

    // Driven through reloadProfile, which is what the error screen's button
    // calls. A rerender would not do: the provider's read happens in a mount
    // effect, so re-rendering never issues a second request and the test would
    // pass or fail for reasons unrelated to retrying.
    fireEvent.press(screen.getByTestId("retry"));

    // A retry that succeeds must take the error screen away, or the button is
    // decorative.
    await waitFor(() => expect(screen.getByTestId("error").props.children).toBe("none"));
    expect(screen.getByTestId("profile").props.children).toBe("present");
  });

  it("stops loading even when the read fails, so the app is never a permanent spinner", async () => {
    mockSingle.mockRejectedValue(new Error("boom"));

    renderAuth();

    // app/_layout.tsx renders a bare full-screen spinner while `loading` is
    // true. A throw used to skip the lowering entirely — the app simply never
    // started.
    await waitFor(() => expect(screen.getByTestId("loading").props.children).toBe("false"));
  });
});
