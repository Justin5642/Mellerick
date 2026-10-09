import AsyncStorage from "@react-native-async-storage/async-storage";
import type { LocalRole } from "./reads/source";

// "This device's PowerSync mirror has completed a full sync for THIS user in
// THIS role." Persisted so a cold start can serve local reads at once.
//
// Without it, PowerSyncProvider registered the local-read seam only after
// waitForFirstSync() resolved for the new connection — so on every app launch
// My Jobs' first render went to the network (fromLocalOr → "no-local"), and
// offline it failed outright while a complete mirror sat on disk from the
// previous session.
//
// The marker is written only AFTER waitForFirstSync() for a connection, and
// cleared BEFORE every disconnectAndClear(), so a crash between the two can
// leave "no marker over a full mirror" (the safe direction: we just wait for
// sync as before) but never "marker over an emptied mirror".

export interface SyncMarker {
  userId: string;
  role: Exclude<LocalRole, null>;
}

const KEY = "mellerick.powersync.synced.v1";

export type ColdStartDecision =
  /** The mirror on disk was fully synced for this user+role: serve it now. */
  | "serve-local"
  /** No marker (first sync ever, or an install predating the marker): today's behaviour — wait. */
  | "wait-for-sync"
  /** The mirror belongs to someone else, or another role: wipe before connecting. */
  | "wipe";

/** Pure: what a cold start may do with the mirror already on disk. */
export function decideColdStart(
  marker: SyncMarker | null,
  userId: string,
  role: Exclude<LocalRole, null>
): ColdStartDecision {
  if (!marker) return "wait-for-sync";
  if (marker.userId === userId && marker.role === role) return "serve-local";
  return "wipe";
}

/** Pure: parse a stored marker, null on anything malformed. */
export function parseSyncMarker(raw: string | null): SyncMarker | null {
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as Partial<SyncMarker>;
    if (!m || typeof m.userId !== "string" || m.userId.length === 0) return null;
    if (m.role !== "admin" && m.role !== "office" && m.role !== "technician") return null;
    return { userId: m.userId, role: m.role };
  } catch {
    return null;
  }
}

export async function readSyncMarker(): Promise<SyncMarker | null> {
  try {
    return parseSyncMarker(await AsyncStorage.getItem(KEY));
  } catch {
    return null; // storage unavailable → behave as a first sync
  }
}

export async function writeSyncMarker(marker: SyncMarker): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(marker));
  } catch {
    /* best-effort: next launch waits for sync, as before */
  }
}

export async function clearSyncMarker(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    /* best-effort */
  }
}
