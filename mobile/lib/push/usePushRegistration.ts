import { useEffect } from "react";
import { Platform } from "react-native";
import Constants from "expo-constants";
import { useAuth } from "../auth-context";
import { registerForPush } from "./registerPush";
import { expoPushGateway, configureForegroundNotifications } from "./expoPushGateway";
import { upsertDeviceToken } from "./deviceTokens";

// Foreground display behaviour is process-wide; set it once at module load.
configureForegroundNotifications();

// Registers this device for push once a user is signed in, and upserts the Expo
// push token to the backend so it can be targeted. Fully best-effort and
// self-guarding: no-op without a signed-in user, on a simulator, if permission is
// declined, if push credentials aren't configured yet, or if the device_tokens
// table isn't migrated — it never throws and never blocks the UI. Call once from
// the authenticated layout.
export function usePushRegistration(): void {
  const { profile } = useAuth();
  const userId = profile?.id;

  useEffect(() => {
    if (!userId) return;
    const projectId = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
    if (!projectId) return;

    let cancelled = false;
    (async () => {
      const result = await registerForPush(expoPushGateway, projectId);
      if (!cancelled && result.status === "registered" && result.token) {
        await upsertDeviceToken({ token: result.token, platform: Platform.OS, userId });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);
}
