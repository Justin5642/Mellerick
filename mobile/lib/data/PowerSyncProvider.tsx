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
  const connectedRole = useRef<LocalRole>(null);

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
    let cancelled = false;
    (async () => {
      if (session && role) {
        if (connectedRole.current === role) return;
        // Role changed while connected: clear the old role's rows first.
        if (connectedRole.current !== null) {
          setLocalReads(null);
          await powersync.disconnectAndClear();
        }
        if (cancelled) return;
        await powersync.connect(connector);
        if (cancelled) return;
        connectedRole.current = role;
        // The captured role is fixed for this connection — the row set on disk
        // was synced under it.
        const frozen = role;
        setLocalReads(makeLocalReads(() => frozen));
      } else {
        if (connectedRole.current === null) return;
        connectedRole.current = null;
        setLocalReads(null);
        // Sign-out (or unknown role): wipe the mirror. Financial rows must not
        // survive on a device with no authenticated user.
        await powersync.disconnectAndClear();
      }
    })().catch((e) => {
      if (__DEV__) console.warn("[powersync] connect/disconnect failed:", e);
    });
    return () => {
      cancelled = true;
    };
  }, [session, role]);

  return <>{children}</>;
}
