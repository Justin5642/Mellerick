import * as BackgroundFetch from "expo-background-fetch";
import * as TaskManager from "expo-task-manager";
import { SqliteOutboxStore } from "./data/outbox/sqliteStore";
import { createDataLayer } from "./data/createDataLayer";
import { supabaseGateway, apiBridge } from "./data/gateway.supabase";
import { netInfoConnectivity } from "./data/net/connectivity";
import { supabase } from "./supabase";
import {
  shouldRegisterBackgroundSync,
  backgroundSyncOutcome,
  MIN_INTERVAL_SECONDS,
} from "./backgroundSyncPlan";

// Drain the outbox while the app is closed.
//
// SyncEngine drains on launch and on connectivity change — both need a running
// app. Queued writes from a job finished in a basement therefore sit in SQLite
// until someone reopens the app, which may be the next morning. This is the
// safety net for that window, and nothing else: the OS decides when (and on
// iOS, whether) a periodic task runs at all.
//
// Decision logic lives in ./backgroundSyncPlan so it can be tested without a
// device; this file is the thin native binding, kept deliberately small because
// almost none of it can be exercised in CI.

export const BACKGROUND_SYNC_TASK = "mellerick-background-sync";

TaskManager.defineTask(BACKGROUND_SYNC_TASK, async () => {
  let drained = 0;
  let error: unknown = null;

  try {
    // A session must exist AND be valid. getSession() refreshes an expired
    // token, which is the common case here — this task fires long after the app
    // was last open, so the access token has usually expired.
    const { data } = await supabase.auth.getSession();
    if (!data.session) {
      return BackgroundFetch.BackgroundFetchResult.NoData;
    }

    const store = await SqliteOutboxStore.open();
    const layer = createDataLayer({
      store,
      gateway: supabaseGateway,
      api: apiBridge,
      connectivity: netInfoConnectivity,
      ensureSession: () => supabase.auth.getSession(),
      // No UI here to show anything, so a failure is captured and reported to
      // the OS rather than thrown — an exception escaping a TaskManager task can
      // make the system stop scheduling it entirely, which would silently end
      // background draining for good.
      onSyncError: (e) => {
        error = e;
      },
    });

    const pendingBefore = await layer.outbox.pendingCount();
    await layer.engine.flush();
    const pendingAfter = await layer.outbox.pendingCount();
    drained = Math.max(0, pendingBefore - pendingAfter);
  } catch (e) {
    error = e;
  }

  switch (backgroundSyncOutcome({ drained, error })) {
    case "new-data":
      return BackgroundFetch.BackgroundFetchResult.NewData;
    case "failed":
      return BackgroundFetch.BackgroundFetchResult.Failed;
    default:
      return BackgroundFetch.BackgroundFetchResult.NoData;
  }
});

/** Register the periodic drain. Safe to call repeatedly; a no-op when already on. */
export async function startBackgroundSync(signedIn: boolean): Promise<boolean> {
  const alreadyRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK);
  if (!shouldRegisterBackgroundSync({ signedIn, alreadyRegistered })) return alreadyRegistered;

  await BackgroundFetch.registerTaskAsync(BACKGROUND_SYNC_TASK, {
    minimumInterval: MIN_INTERVAL_SECONDS,
    stopOnTerminate: false, // Android: survive the app being swept away
    startOnBoot: true, // Android: resume after a restart
  });
  return true;
}

/** Stop on sign-out, so a queued write is never replayed under a new session. */
export async function stopBackgroundSync(): Promise<void> {
  if (!(await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK))) return;
  await BackgroundFetch.unregisterTaskAsync(BACKGROUND_SYNC_TASK);
}
