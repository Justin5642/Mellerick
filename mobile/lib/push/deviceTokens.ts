import { supabase } from "../supabase";

// Upsert this device's Expo push token so the backend can target it for pushes.
// Keyed on the token (a re-registering device updates its user + timestamp).
// Online-only device metadata — best-effort: a failure (offline, or the
// device_tokens table not yet migrated on the backend) is swallowed so it can
// never block sign-in or app use. See the PROPOSED device_tokens migration.
export async function upsertDeviceToken(input: { token: string; platform: string; userId: string }): Promise<boolean> {
  try {
    const { error } = await supabase
      .from("device_tokens")
      .upsert(
        { token: input.token, user_id: input.userId, platform: input.platform, updated_at: new Date().toISOString() },
        { onConflict: "token" }
      );
    return !error;
  } catch {
    return false;
  }
}
