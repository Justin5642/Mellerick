import { Platform } from "react-native";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import type { PushGateway, PermissionStatus } from "./gateway";

// The thin, real binding of PushGateway to expo-notifications / expo-device. Kept
// tiny and free of branching logic (that lives in the unit-tested registerPush.ts)
// so there's little here that can be wrong without a device.

function mapStatus(status: Notifications.PermissionStatus): PermissionStatus {
  if (status === "granted") return "granted";
  if (status === "denied") return "denied";
  return "undetermined";
}

export const expoPushGateway: PushGateway = {
  isDevice: () => Device.isDevice,
  async getPermissionStatus() {
    return mapStatus((await Notifications.getPermissionsAsync()).status);
  },
  async requestPermission() {
    return mapStatus((await Notifications.requestPermissionsAsync()).status);
  },
  async getExpoPushToken(projectId: string) {
    // Android needs a notification channel before a token can deliver.
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "Default",
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
    const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
    return data;
  },
};

// Foreground display behaviour. Safe to call at module load; no permissions needed.
export function configureForegroundNotifications(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}
