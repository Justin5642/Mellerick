// The native seam for push registration, mirroring how the data layer isolates
// SupabaseGateway / ApiBridge / Connectivity. The pure registration flow
// (registerPush.ts) depends only on this interface, so it is fully unit-testable
// with a fake; expoPushGateway.ts is the thin real binding to expo-notifications.

export type PermissionStatus = "granted" | "denied" | "undetermined";

export interface PushGateway {
  /** Push tokens are only issued on a physical device (never a simulator). */
  isDevice(): boolean;
  getPermissionStatus(): Promise<PermissionStatus>;
  requestPermission(): Promise<PermissionStatus>;
  /** The Expo push token for this device+project (throws if unavailable). */
  getExpoPushToken(projectId: string): Promise<string>;
}

export type RegisterStatus = "registered" | "denied" | "unavailable" | "no-device";

export interface RegisterPushResult {
  status: RegisterStatus;
  token: string | null;
}
