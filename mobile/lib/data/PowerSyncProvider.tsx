import React, { useEffect, useRef } from "react";
import { useAuth } from "../auth-context";
import { useDataLayer } from "./DataProvider";
import { markWritesSettled, setLocalReads, type LocalRole } from "./reads/source";
import { recordReadOnlyViolation, setPowerSyncStatus } from "./powersyncStatus";
import { runTransition, type TransitionDeps, type TransitionState } from "./powersyncTransition";
import { clearSyncMarker, readSyncMarker, writeSyncMarker } from "./syncMarker";
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
//  • The CONFIRMED seam is registered only AFTER waitForFirstSync resolves for
//    the new connection, so a role change can never serve the previous role's
//    (or a partially-downloaded) row set under a stale hasSynced flag.
//  • Exception, cold start only: when the persisted marker (lib/data/
//    syncMarker) records that the mirror on disk COMPLETED a full sync for this
//    exact user AND role, a provisional seam is registered immediately, so My
//    Jobs' first render reads locally instead of waiting on the network. A
//    marker for anyone else wipes the mirror first. Logic and tests:
//    lib/data/powersyncTransition.ts.
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
  // A DEACTIVATED account gets no role here, which routes it down the sign-out
  // branch and wipes the mirror: app/_layout.tsx only hides the screens, and an
  // office user switched off in staff.tsx must not keep invoice rows on disk.
  const role = profile?.is_active === true ? asLocalRole(profile.role) : null;
  const userId = session?.user?.id ?? null;
  // Who is connected / synced / vouched-for — see lib/data/powersyncTransition.
  const state = useRef<TransitionState>({ connected: null, synced: null, trusted: null });
  // All connect/disconnect work appends here — one transition at a time.
  const transitions = useRef<Promise<void>>(Promise.resolve());
  // Bumped on every transition; a queued setLocalReads only applies if its
  // generation is still current when the first sync completes.
  const generation = useRef(0);
  // Aborts the previous transition's waitForFirstSync. Without it a transition
  // waiting OFFLINE for a first sync that never comes blocked the chain
  // forever — every later transition (a sign-out's wipe included) queued
  // behind it. Aborting resolves the wait; the generation check then stops the
  // superseded transition from registering anything.
  const waitAbort = useRef<AbortController | null>(null);

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

  // Keyed on the USER and ROLE, not the session object. Every TOKEN_REFRESHED
  // hands auth-context a new session object; keying on it re-ran this
  // transition hourly for an identity that had not changed.
  useEffect(() => {
    const gen = ++generation.current;
    waitAbort.current?.abort();
    const abort = new AbortController();
    waitAbort.current = abort;
    const deps: TransitionDeps = {
      connect: () => powersync.connect(connector),
      disconnectAndClear: () => powersync.disconnectAndClear(),
      waitForFirstSync: () => powersync.waitForFirstSync(abort.signal),
      makeLocalReads,
      setLocalReads,
      readMarker: readSyncMarker,
      writeMarker: writeSyncMarker,
      clearMarker: clearSyncMarker,
    };
    transitions.current = transitions.current.then(async () => {
      if (gen !== generation.current) return; // superseded while queued
      try {
        await runTransition(deps, state.current, { userId, role }, () => gen === generation.current);
      } catch (e) {
        if (__DEV__) console.warn("[powersync] connect/disconnect failed:", e);
      }
    });
  }, [userId, role]);

  // Final unmount: stop syncing. (Data is wiped on sign-out, not here — an
  // app restart with a live session should reuse the mirror, not re-download.)
  useEffect(() => {
    return () => {
      generation.current++;
      waitAbort.current?.abort();
      setLocalReads(null);
      transitions.current = transitions.current.then(() => powersync.disconnect());
    };
  }, []);

  return <>{children}</>;
}
