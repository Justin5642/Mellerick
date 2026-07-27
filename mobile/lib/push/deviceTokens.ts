import { supabase } from "../supabase";

// Upsert this device's Expo push token so the backend can target it for pushes.
// Keyed on the token (a re-registering device updates its user + timestamp).
// Online-only device metadata — best-effort: a failure (offline, or the
// device_tokens table not yet migrated on the backend) is swallowed so it can
// never block sign-in or app use. See the PROPOSED device_tokens migration.
export async function upsertDeviceToken(input: { token: string; platform: string; userId: string }): Promise<boolean> {
  try {
    // updated_at is owned by the DB (default now() on insert + a BEFORE UPDATE
    // trigger on conflict), not the device clock — see 0036_device_tokens.sql.
    const { error } = await supabase
      .from("device_tokens")
      .upsert({ token: input.token, user_id: input.userId, platform: input.platform }, { onConflict: "token" });
    return !error;
  } catch {
    return false;
  }
}
