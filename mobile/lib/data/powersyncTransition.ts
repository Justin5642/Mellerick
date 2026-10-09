import type { LocalReads, LocalRole } from "./reads/source";
import { decideColdStart, type SyncMarker } from "./syncMarker";

// The body of one PowerSyncProvider connect/disconnect transition, lifted out
// of the component so it can be driven with fakes (powersyncTransition.test.ts)
// — the provider itself imports the native PowerSync module, which no unit
// test may load.
//
// The provider still owns serialization (one transition at a time) and the
// generation counter; `isCurrent()` is how a transition learns it has been
// superseded and must not register a seam.

export interface TransitionDeps {
  connect(): Promise<void>;
  disconnectAndClear(): Promise<void>;
  waitForFirstSync(): Promise<void>;
  makeLocalReads(role: () => LocalRole, opts?: { assumeSynced?: boolean }): LocalReads;
  setLocalReads(db: LocalReads | null): void;
  readMarker(): Promise<SyncMarker | null>;
  writeMarker(marker: SyncMarker): Promise<void>;
  clearMarker(): Promise<void>;
}

type Who = { userId: string; role: Exclude<LocalRole, null> };

/** Mutable across transitions — the provider keeps one in a ref. */
export interface TransitionState {
  /** Who PowerSync is CONNECTED as. Decides whether a disconnect is owed. */
  connected: Who | null;
  /**
   * Whose first sync COMPLETED in this app session (seam registered on a
   * confirmed sync). Deliberately separate from `connected`: gating the early
   * return on "connected" made a lost seam permanent — a transition superseded
   * during waitForFirstSync skipped registration, and the next one returned
   * early because the connection had already been recorded.
   */
  synced: Who | null;
  /**
   * Whose ON-DISK mirror the persisted marker vouched for at cold start. Kept
   * in state (not just acted on once) so a transition superseded before it
   * could register the provisional seam — a token refresh landing mid-start —
   * does not lose it: the next transition for the same identity re-registers.
   */
  trusted: Who | null;
}

const same = (a: Who | null, b: Who | null) => !!a && !!b && a.userId === b.userId && a.role === b.role;

export async function runTransition(
  deps: TransitionDeps,
  state: TransitionState,
  input: { userId: string | null; role: LocalRole },
  isCurrent: () => boolean
): Promise<void> {
  if (input.userId && input.role) {
    const who: Who = { userId: input.userId, role: input.role };
    // Gated on the identity that FINISHED syncing, not the one we started
    // connecting for (see TransitionState.synced).
    if (same(state.synced, who)) return;

    if (!same(state.connected, who)) {
      // Any previous connection's rows are for the wrong user/role now.
      deps.setLocalReads(null);
      if (state.connected !== null) {
        // In-session role change (a demoted office user must not keep serving
        // invoice rows). Marker FIRST: a crash mid-wipe must never leave a
        // marker vouching for an emptied mirror.
        state.connected = null;
        state.synced = null;
        state.trusted = null;
        await deps.clearMarker();
        await deps.disconnectAndClear();
      } else {
        // COLD START (or the first connect after sign-in). The mirror on disk
        // may already be complete for this exact user+role from the previous
        // app session — if lib/data/syncMarker says so, serve it NOW instead of
        // sending every first read to the network until this connection's
        // first sync lands (offline, that is never). The ordinary fallbacks in
        // fromLocalOr (role, write-echo, stale-db, local-threw) still apply.
        const decision = decideColdStart(await deps.readMarker(), who.userId, who.role);
        state.trusted = null;
        if (decision === "wipe") {
          await deps.clearMarker();
          await deps.disconnectAndClear();
        } else if (decision === "serve-local") {
          state.trusted = who;
        }
        // "wait-for-sync": first sync ever (or an install predating the
        // marker) — unchanged behaviour, nothing local until it completes.
      }
      if (same(state.trusted, who) && isCurrent()) {
        const frozen = who.role;
        deps.setLocalReads(deps.makeLocalReads(() => frozen, { assumeSynced: true }));
      }
      await deps.connect();
      state.connected = who;
    } else if (same(state.trusted, who) && isCurrent()) {
      // Already connected, first sync still pending, and an earlier transition
      // was superseded before registering the provisional seam: do it now.
      const frozen = who.role;
      deps.setLocalReads(deps.makeLocalReads(() => frozen, { assumeSynced: true }));
    }

    // Register the confirmed seam only once THIS connection has fully synced.
    await deps.waitForFirstSync();
    if (isCurrent() && same(state.connected, who)) {
      state.synced = who;
      const frozen = who.role;
      deps.setLocalReads(deps.makeLocalReads(() => frozen));
      await deps.writeMarker(who);
    }
    return;
  }

  // Signed out, unknown role, or deactivated.
  if (state.connected === null && state.synced === null) return;
  state.connected = null;
  state.synced = null;
  state.trusted = null;
  deps.setLocalReads(null);
  // Wipe the mirror: financial rows must not survive on a device with no
  // authenticated user. Marker first, for the same reason as above.
  await deps.clearMarker();
  await deps.disconnectAndClear();
}
