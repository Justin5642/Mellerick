import { useCallback } from "react";
import { Alert } from "react-native";
import { useAuth } from "./auth-context";
import { useDataLayer } from "./data/DataProvider";
import { runSignOut } from "./signOutFlow";
import { clockQueueStore } from "./backgroundClock";
import { clearClockActions, countClockActions } from "./backgroundClockQueue";

function confirmSignOut(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      "Unsynced work",
      message,
      [
        { text: "Stay signed in", style: "cancel", onPress: () => resolve(false) },
        { text: "Sign out anyway", style: "destructive", onPress: () => resolve(true) },
      ],
      // Android: tapping outside the dialog dismisses it — that is "no".
      { cancelable: true, onDismiss: () => resolve(false) }
    );
  });
}

/**
 * The sign-out every button uses: warns about unsynced work, then clears the
 * outbox and staged files along with the session. See lib/signOutFlow.ts.
 */
export function useSignOut(): () => Promise<void> {
  const { session, signOut } = useAuth();
  const layer = useDataLayer();
  const userId = session?.user?.id ?? null;
  return useCallback(async () => {
    try {
      await runSignOut({
        userId,
        layer,
        confirm: confirmSignOut,
        signOut,
        countClockActions: (id) => countClockActions(clockQueueStore, id),
        clearClockActions: (id) => clearClockActions(clockQueueStore, id),
      });
    } catch (e) {
      // Nothing above is expected to throw; if it does, say so rather than
      // leave a dead button.
      Alert.alert("Sign out failed", e instanceof Error ? e.message : String(e));
    }
  }, [userId, layer, signOut]);
}
