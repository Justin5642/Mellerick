// The PowerSync/Supabase read seam.
//
// Read modules never import PowerSync. They call fromLocalOr(local, remote):
// `local` runs against the device SQLite via the narrow LocalReads surface
// registered here; `remote` is the module's original Supabase body, kept
// verbatim so the fallback is byte-identical to today's behaviour.
//
// The decision is re-evaluated on EVERY call — sign-out, role change or
// first-sync completion flips the source with no re-render plumbing — and a
// local failure (schema drift, SQL typo) degrades to the network instead of
// throwing at a screen.

export type LocalRole = "admin" | "office" | "technician" | null;

/** The only surface a read module sees. A strict subset of PowerSync's query API. */
export interface LocalReads {
  /** First sync has completed and local tables are populated. */
  hasSynced(): boolean;
  /** The role PowerSync connected with — the local row set is scoped to it. */
  role(): LocalRole;
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>;
  getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>;
}

let current: LocalReads | null = null;
export function setLocalReads(db: LocalReads | null): void {
  current = db;
}
export function getLocalReads(): LocalReads | null {
  return current;
}

// Write-echo window: after the outbox drains, PowerSync's download lags the
// server by a round-trip. Reads served locally in that window would show the
// world WITHOUT the write that was just confirmed — worse than a slow read.
const ECHO_WINDOW_MS = 5_000;
let echoUntil = 0;
export function markWritesSettled(now: number = Date.now()): void {
  echoUntil = now + ECHO_WINDOW_MS;
}

/**
 * True while the write-echo window is genuinely open.
 *
 * `echoUntil` is an ABSOLUTE device timestamp, and the phone's clock is not
 * trustworthy across a long shift — NTP pulls a fast handset back, or a
 * different timezone offset is picked up on the road. A backward jump would
 * leave `now < echoUntil` true for the length of the jump, forcing EVERY read
 * onto the network. Offline, that is not a slow read, it is no read at all: a
 * technician in a basement would see failures while holding a complete local
 * mirror, which is the one thing this app exists to prevent.
 *
 * The window is ECHO_WINDOW_MS wide by construction, so a remaining wait longer
 * than that is evidence the clock moved rather than that the window is real.
 */
function isInEchoWindow(now: number): boolean {
  if (now >= echoUntil) return false;
  return echoUntil - now <= ECHO_WINDOW_MS;
}

export type ReadOrigin = "local" | "remote";
export type ReadOriginReason =
  | "no-local"
  | "not-synced"
  | "write-echo"
  | "role"
  | "local-threw"
  | "stale-db";

type OriginListener = (origin: ReadOrigin, reason?: ReadOriginReason) => void;
const originListeners = new Set<OriginListener>();
/** Observability: the sync status UI subscribes to see where reads are served from. */
export function onReadOrigin(cb: OriginListener): () => void {
  originListeners.add(cb);
  return () => originListeners.delete(cb);
}
function emit(origin: ReadOrigin, reason?: ReadOriginReason) {
  for (const cb of originListeners) cb(origin, reason);
}

export interface RouteOptions {
  /**
   * Roles for which the local SQL is a faithful substitute. Any other role
   * (or an unknown one) is routed to Supabase, where RLS gives a loud denial
   * instead of a silently-empty local table. Default: all roles.
   */
  roles?: Exclude<LocalRole, null>[];
  /** Test seam for the echo clock. */
  now?: () => number;
}

export async function fromLocalOr<T>(
  local: (db: LocalReads) => Promise<T>,
  remote: () => Promise<T>,
  opts: RouteOptions = {}
): Promise<T> {
  const now = (opts.now ?? Date.now)();
  const db = current;
  if (!db) {
    emit("remote", "no-local");
    return remote();
  }
  if (!db.hasSynced()) {
    emit("remote", "not-synced");
    return remote();
  }
  if (isInEchoWindow(now)) {
    emit("remote", "write-echo");
    return remote();
  }
  if (opts.roles) {
    const role = db.role();
    if (role === null || !opts.roles.includes(role)) {
      emit("remote", "role");
      return remote();
    }
  }
  try {
    const result = await local(db);
    // Teardown race: if sign-out/role-change cleared the mirror while this
    // query was in flight, its rows came from an emptied database — discard
    // them and answer from the network instead of flashing an empty screen.
    if (getLocalReads() !== db) {
      emit("remote", "stale-db");
      return remote();
    }
    emit("local");
    return result;
  } catch (e) {
    // A local read must never take a screen down — degrade and report.
    emit("remote", "local-threw");
    if (__DEV__) console.warn("[reads] local query failed, fell back to Supabase:", e);
    return remote();
  }
}

/** Test helper: reset module state between tests. */
export function resetSourceForTests(): void {
  current = null;
  echoUntil = 0;
  originListeners.clear();
}
