import AsyncStorage from "@react-native-async-storage/async-storage";

// The signed-in user's own profile, cached on the device so a cold start can
// render the right role's screens WITHOUT a network round-trip.
//
// Before this, app/_layout.tsx held a full-screen spinner until a NETWORK read
// of `profiles` came back — and offline with nothing cached that read failed
// into the profile-error screen. A technician in a basement opened the app to a
// retry button instead of the jobs sitting in their local mirror.
//
// RULES (each pinned by profileCache.test.ts):
//  • Keyed by user id, and the stored record repeats the id. A record is only
//    ever returned for the user it was written for — never across users, even
//    if a key were somehow reused.
//  • Optimistic only. The cache paints the first frame; the server read that
//    follows always wins once it ARRIVES (decideProfileResult). A cached role
//    is never preferred over a fresh server answer.
//  • A definitive server "no such profile" (PostgREST PGRST116 from .single())
//    clears the cache and drops the profile — fail closed. A transient failure
//    (offline, timeout, 5xx) keeps what is on screen.
//  • Cleared on sign-out.
//
// The cached role is a UI hint, not an authorization. Every server read is
// still RLS-checked as the real user, and what PowerSync streams to the device
// is decided by the server-side profiles row (sync-streams.yaml joins on it),
// so editing this record on a rooted phone grants no data.

export interface CachedProfile {
  id: string;
  full_name: string;
  email: string;
  role: string;
  is_active: boolean;
}

interface StoredRecord {
  v: 1;
  userId: string;
  profile: CachedProfile;
}

const PREFIX = "mellerick.profile.v1:";
export const profileCacheKey = (userId: string) => `${PREFIX}${userId}`;

/** Picks exactly the fields the app gates on — `select("*")` must not leak extra columns into storage. */
export function toCachedProfile(row: unknown): CachedProfile | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.length === 0) return null;
  return {
    id: r.id,
    full_name: typeof r.full_name === "string" ? r.full_name : "",
    email: typeof r.email === "string" ? r.email : "",
    role: typeof r.role === "string" ? r.role : (null as unknown as string),
    // Anything other than an explicit `true` is treated as inactive: the
    // deactivated screen is the fail-closed direction.
    is_active: r.is_active === true,
  };
}

/** Pure: parse a stored record, returning it ONLY if it belongs to `userId`. */
export function parseCachedProfile(raw: string | null, userId: string): CachedProfile | null {
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as Partial<StoredRecord>;
    if (!rec || rec.v !== 1 || rec.userId !== userId) return null;
    const profile = toCachedProfile(rec.profile);
    if (!profile || profile.id !== userId) return null;
    return profile;
  } catch {
    return null;
  }
}

export async function readCachedProfile(userId: string): Promise<CachedProfile | null> {
  try {
    return parseCachedProfile(await AsyncStorage.getItem(profileCacheKey(userId)), userId);
  } catch {
    // Storage unavailable: behave exactly as before the cache existed.
    return null;
  }
}

export async function writeCachedProfile(profile: CachedProfile): Promise<void> {
  try {
    const rec: StoredRecord = { v: 1, userId: profile.id, profile };
    await AsyncStorage.setItem(profileCacheKey(profile.id), JSON.stringify(rec));
  } catch {
    /* best-effort: the next launch just takes the network path */
  }
}

/** Removes every cached profile — one user's, or (no argument) all of them. */
export async function clearCachedProfile(userId?: string): Promise<void> {
  try {
    if (userId) {
      await AsyncStorage.removeItem(profileCacheKey(userId));
      return;
    }
    const keys = await AsyncStorage.getAllKeys();
    const ours = keys.filter((k) => k.startsWith(PREFIX));
    if (ours.length > 0) await AsyncStorage.multiRemove(ours);
  } catch {
    /* best-effort */
  }
}

/** PostgREST's ".single() matched zero rows" — the server saying there is no profile. */
export function isDefinitiveNoProfile(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { code?: unknown }).code === "PGRST116";
}

export type ProfileDecision =
  /** The server answered: show this and cache it. Always wins over the cache. */
  | { kind: "apply"; profile: CachedProfile }
  /** The server said there is no profile: drop what is shown, clear the cache. */
  | { kind: "clear" }
  /** Transient failure while something is already shown: keep it. */
  | { kind: "keep" }
  /** Failure with nothing to show: surface the error screen. */
  | { kind: "error"; error: unknown };

/**
 * Pure: what to do with a profiles read result, given what is on screen now
 * (a profile from cache or from an earlier read, or nothing).
 */
export function decideProfileResult(input: {
  shown: CachedProfile | null;
  data: unknown;
  error: unknown;
}): ProfileDecision {
  const { shown, data, error } = input;
  if (!error) {
    const profile = toCachedProfile(data);
    if (profile) return { kind: "apply", profile };
    return { kind: "clear" };
  }
  if (isDefinitiveNoProfile(error)) return { kind: "clear" };
  if (shown) return { kind: "keep" };
  return { kind: "error", error };
}
