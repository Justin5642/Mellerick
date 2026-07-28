// Module-level snapshot of PowerSync's download/connection state and the
// read-only tripwire, kept OUT of React so pure-JS code (useSyncStatus, tests)
// can read it without importing anything native. PowerSyncProvider is the only
// writer.

export interface PowerSyncStatusSnapshot {
  connected: boolean;
  downloading: boolean;
  hasSynced: boolean;
  lastSyncedAt: Date | null;
}

const zero: PowerSyncStatusSnapshot = {
  connected: false,
  downloading: false,
  hasSynced: false,
  lastSyncedAt: null,
};

let snapshot: PowerSyncStatusSnapshot = zero;
let violations: string[] = [];
type Listener = () => void;
const listeners = new Set<Listener>();

/** Accepts PowerSync's SyncStatus (structurally) — or anything with these getters. */
export function setPowerSyncStatus(status: {
  connected: boolean;
  downloading: boolean;
  hasSynced?: boolean;
  lastSyncedAt?: Date;
}): void {
  snapshot = {
    connected: status.connected,
    downloading: status.downloading,
    hasSynced: status.hasSynced === true,
    lastSyncedAt: status.lastSyncedAt ?? null,
  };
  for (const l of listeners) l();
}

export function getPowerSyncStatus(): PowerSyncStatusSnapshot {
  return snapshot;
}

/** The read-only contract was violated: some code wrote through PowerSync. */
export function recordReadOnlyViolation(detail: string): void {
  violations = [...violations, detail];
  for (const l of listeners) l();
}

export function getReadOnlyViolations(): readonly string[] {
  return violations;
}

export function onPowerSyncStatusChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Test helper. */
export function resetPowerSyncStatusForTests(): void {
  snapshot = zero;
  violations = [];
  listeners.clear();
}
