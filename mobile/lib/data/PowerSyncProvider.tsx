import React, { useEffect, useRef } from "react";
import { useAuth } from "../auth-context";
import { useDataLayer } from "./DataProvider";
import { markWritesSettled, setLocalReads, type LocalRole } from "./reads/source";
import { recordReadOnlyViolation, setPowerSyncStatus } from "./powersyncStatus";
import { supabase } from "../supabase";
import { MellerickConnector } from "../../powersync/connector";
import { makeLocalReads, powersync } from "../../powersync/db";

// Mounts inside DataProvider. Connects PowerSync when a signed-in user with a
// known role exists, registers the LocalReads seam, and tears both down on
// sign-out or ROLE CHANGE — a demoted office user's device must not keep
// serving invoice rows from the local mirror.
//
// Two hardening rules (from the phase-gate review):
//  • Transitions are SERIALIZED through a promise chain — rapid session/role
//    churn cannot interleave a connect with a disconnectAndClear.
//  • The seam is registered only AFTER waitForFirstSync resolves for the new
//    connection, so a role change can never serve the previous role's (or a
//    partially-downloaded) row set under a stale hasSynced flag.
//
// Reads-only integration: uploadData is a tripwire (see powersync/connector.ts)
// and every write still goes through the outbox.

const connector = new MellerickConnector(
  {
    async getAccessToken() {
      // getSession() refreshes when expired — "always fetch fresh credentials".
      const { data } = await supabase.auth.getSession();
      const s = data.session;
      if (!s) return null;
      return {
        token: s.access_token,
        expiresAt: s.expires_at ? new Date(s.expires_at * 1000) : null,
      };
    },
  },
  recordReadOnlyViolation
);

function asLocalRole(role: string | undefined | null): LocalRole {
  return role === "admin" || role === "office" || role === "technician" ? role : null;
}

export function PowerSyncProvider({ children }: { children: React.ReactNode }) {
  const { session, profile } = useAuth();
  const layer = useDataLayer();
  const role = asLocalRole(profile?.role);
  /** The role PowerSync is CONNECTED as. Decides whether a disconnect is owed. */
  const connectedRole = useRef<LocalRole>(null);
  /**
   * The role whose first sync COMPLETED and whose local reads are registered.
   *
   * Deliberately separate from connectedRole. Gating the early return on
   * "connected" made a lost seam permanent: a transition superseded during
   * waitForFirstSync skipped registration, and the next one returned early
   * because the connection had already been recorded.
   */
  const syncedRole = useRef<LocalRole>(null);
  // All connect/disconnect work appends here — one transition at a time.
  const transitions = useRef<Promise<void>>(Promise.resolve());
  // Bumped on every transition; a queued setLocalReads only applies if its
  // generation is still current when the first sync completes.
  const generation = useRef(0);

  // Route reads remotely for a beat after each outbox drain — the local mirror
  // lags a confirmed write by one download round-trip.
  useEffect(() => {
    if (!layer) return;
    return layer.engine.onSettled(() => markWritesSettled());
  }, [layer]);

  // Surface PowerSync connection state alongside the outbox state.
  useEffect(() => {
    setPowerSyncStatus(powersync.currentStatus);
    return powersync.registerListener({
      statusChanged: (status) => setPowerSyncStatus(status),
    });
  }, []);

  useEffect(() => {
    const gen = ++generation.current;
    transitions.current = transitions.current.then(async () => {
      if (gen !== generation.current) return; // superseded while queued
      try {
        if (session && role) {
          // GATED ON THE ROLE THAT FINISHED SYNCING, not the one we started
          // connecting for.
          //
          // These used to be the same ref, set immediately after connect() and
          // before waitForFirstSync(). That made a lost seam PERMANENT for the
          // app session: a TOKEN_REFRESHED landing mid-sync bumps the
          // generation, so transition #1 skipped setLocalReads — and transition
          // #2 then returned early here, because the ref already said "we are
          // on this role". Local reads were never registered again, and every
          // read fell back to the network for the rest of the session. On a
          // technician's phone in a basement that is not a slowdown, it is a
          // dead app. auth-context re-emits on every token refresh, so the
          // trigger was routine rather than exotic.
          if (syncedRole.current === role) return;

          // Any previous connection's rows are for the wrong role now.
          setLocalReads(null);
          if (connectedRole.current !== null) {
            await powersync.disconnectAndClear();
          }
          await powersync.connect(connector);
          // Tracked separately from syncedRole, and ONLY so the next transition
          // knows a disconnect is owed. It must not gate the early return.
          connectedRole.current = role;

          // Register the seam only once THIS connection has fully synced — a
          // persisted hasSynced from the previous role must not count.
          const frozen = role;
          await powersync.waitForFirstSync();
          if (gen === generation.current && connectedRole.current === frozen) {
            syncedRole.current = frozen;
            setLocalReads(makeLocalReads(() => frozen));
          }
        } else {
          if (connectedRole.current === null && syncedRole.current === null) return;
          connectedRole.current = null;
          syncedRole.current = null;
          setLocalReads(null);
          // Sign-out (or unknown role): wipe the mirror. Financial rows must
          // not survive on a device with no authenticated user.
          await powersync.disconnectAndClear();
        }
      } catch (e) {
        if (__DEV__) console.warn("[powersync] connect/disconnect failed:", e);
      }
    });
  }, [session, role]);

  // Final unmount: stop syncing. (Data is wiped on sign-out, not here — an
  // app restart with a live session should reuse the mirror, not re-download.)
  useEffect(() => {
    return () => {
      generation.current++;
      setLocalReads(null);
      transitions.current = transitions.current.then(() => powersync.disconnect());
    };
  }, []);

  return <>{children}</>;
}
