import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "../supabase";

// The token this device last registered, so sign-out can remove exactly that
// row. Reading it back from expo-notifications at sign-out would need the
// permission/projectId dance again, and can fail offline.
export const REGISTERED_TOKEN_KEY = "mellerick.push.registeredToken";

// How long sign-out will wait on the server before giving up on the delete.
const REMOVE_TIMEOUT_MS = 5_000;

// Register this device's Expo push token for the signed-in user.
//
// claim_device_token() (migration 0078, a draft, not applied yet) hands the
// token to whoever is signed in now. The plain upsert below could not: on a
// shared or handed-down phone the row still belonged to the previous person,
// RLS refused the update, and the new person's job notifications kept going to
// the previous person. Until 0078 is applied the RPC does not exist, so this
// falls back to the old upsert (which works for a phone with one user).
//
// Online-only device metadata — best-effort: a failure is swallowed so it can
// never block sign-in or app use. updated_at is owned by the DB (0036).
export async function upsertDeviceToken(input: { token: string; platform: string; userId: string }): Promise<boolean> {
  try {
    const claim = await supabase.rpc("claim_device_token", { p_token: input.token, p_platform: input.platform });
    let error = claim.error;
    if (error && isMissingFunction(error)) {
      ({ error } = await supabase
        .from("device_tokens")
        .upsert({ token: input.token, user_id: input.userId, platform: input.platform }, { onConflict: "token" }));
    }
    if (!error) await AsyncStorage.setItem(REGISTERED_TOKEN_KEY, input.token).catch(() => {});
    return !error;
  } catch {
    return false;
  }
}

// PostgREST reports an RPC the database does not have as PGRST202 (or the
// underlying 42883). Anything else is a real refusal and must not fall back.
function isMissingFunction(error: { code?: string; message?: string }): boolean {
  return error.code === "PGRST202" || error.code === "42883";
}

/**
 * Delete this device's push-token row. Called at sign-out, BEFORE the session
 * ends — the row is only deletable by its owner (0036's "own device tokens"
 * policy), so afterwards nobody on the phone could remove it.
 *
 * WHY. The row outlived the session: the office kept pushing the previous
 * person's job assignments and schedule changes to a phone they had signed out
 * of — or handed back, or lost. Until someone else signed in on it and the
 * upsert re-keyed the token, the lock screen kept showing another technician's
 * work.
 *
 * Best-effort and bounded: offline, sign-out must still happen, promptly. A
 * row left behind then is no worse than before, and is re-owned by the next
 * sign-in's upsert. Never throws. Returns whether the row is known to be gone.
 */
export async function removeDeviceToken(): Promise<boolean> {
  try {
    const token = await AsyncStorage.getItem(REGISTERED_TOKEN_KEY);
    if (!token) return true;
    const attempt = (async () => {
      const { error } = await supabase.from("device_tokens").delete().eq("token", token);
      if (error) {
        console.warn("[push] could not remove this device's token at sign-out:", error.message);
        return false;
      }
      return true;
    })();
    const timeout = new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), REMOVE_TIMEOUT_MS);
      (t as unknown as { unref?: () => void }).unref?.();
    });
    const removed = await Promise.race([attempt, timeout]);
    // Forget the token either way: it is re-registered (and re-stored) by the
    // next sign-in, whoever that is.
    await AsyncStorage.removeItem(REGISTERED_TOKEN_KEY).catch(() => {});
    return removed;
  } catch {
    return false;
  }
}
