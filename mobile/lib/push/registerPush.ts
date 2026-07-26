import type { PushGateway, RegisterPushResult } from "./gateway";

// Pure push-registration flow (offline-safe, no side effects beyond the gateway):
//   • not a physical device            → "no-device" (simulators can't get a token)
//   • permission undetermined          → request it once
//   • permission not granted           → "denied" (the app still works without push)
//   • token fetch fails (no creds/net) → "unavailable" (degrade gracefully)
//   • otherwise                        → "registered" with the Expo push token
// Never throws — a push failure must never block sign-in or app use.
export async function registerForPush(gateway: PushGateway, projectId: string): Promise<RegisterPushResult> {
  if (!gateway.isDevice()) return { status: "no-device", token: null };

  let status = await gateway.getPermissionStatus();
  if (status === "undetermined") status = await gateway.requestPermission();
  if (status !== "granted") return { status: "denied", token: null };

  try {
    const token = await gateway.getExpoPushToken(projectId);
    return token ? { status: "registered", token } : { status: "unavailable", token: null };
  } catch {
    return { status: "unavailable", token: null };
  }
}
