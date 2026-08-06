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

// GUARDED, NOT STATIC — the same bug as backgroundClockTask.ts, one file later.
//
// `import * as TaskManager from "expo-task-manager"` throws at MODULE LOAD when
// the native module is absent. This file is reached from app/_layout.tsx by way
// of location-tracking.tsx, so that throw happens during startup and takes the
// ENTIRE APP down to a red screen:
//
//     Uncaught Error: Cannot find native module 'ExpoTaskManager'
//
// backgroundClockTask.ts was fixed with a guarded require after exactly this was
// found on a device, and pinned by backgroundClockTask.guard.test.ts. This file
// was added afterwards with static imports and no guard, reintroducing it. Every
// unit test passed while that was true, because jest resolves the JS package
// happily — only a real launch reveals it.
//
// A missing background-sync module must degrade to "no background draining",
// never to "no app". backgroundSync.guard.test.ts now pins BOTH modules.
interface TaskManagerModule {
  defineTask(name: string, body: () => Promise<number>): void;
  isTaskRegisteredAsync(name: string): Promise<boolean>;
}
interface BackgroundFetchModule {
  BackgroundFetchResult: { NoData: number; NewData: number; Failed: number };
  registerTaskAsync(name: string, options: Record<string, unknown>): Promise<void>;
  unregisterTaskAsync(name: string): Promise<void>;
}

let TaskManager: TaskManagerModule | null = null;
let BackgroundFetch: BackgroundFetchModule | null = null;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  TaskManager = require("expo-task-manager") as TaskManagerModule;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  BackgroundFetch = require("expo-background-fetch") as BackgroundFetchModule;
} catch (e) {
  console.warn(
    "[backgroundSync] expo-task-manager/expo-background-fetch unavailable — background sync is OFF " +
      "for this build. Queued writes will drain when the app is next opened rather than while it is " +
      "closed. Rebuild the dev client (npx expo run:android) after adding the dependency.",
    e
  );
}

// Only define the task when BOTH modules loaded. Defining it against a null
// module would move the same crash from import time to first invocation.
if (TaskManager && BackgroundFetch) {
  const fetchResult = BackgroundFetch.BackgroundFetchResult;
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
        return fetchResult.NewData;
      case "failed":
        return fetchResult.Failed;
      default:
        return fetchResult.NoData;
    }
  });
}

/**
 * Register the periodic drain. Safe to call repeatedly; a no-op when already on.
 *
 * Resolves FALSE rather than rejecting when the native module is absent. The
 * caller in location-tracking.tsx uses `.catch()`, but an unhandled rejection in
 * React Native renders as a full-screen red box over an otherwise working app —
 * the same user-visible outcome the import guard above exists to prevent.
 */
export async function startBackgroundSync(signedIn: boolean): Promise<boolean> {
  if (!TaskManager || !BackgroundFetch) return false;

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
  if (!TaskManager || !BackgroundFetch) return;
  if (!(await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK))) return;
  await BackgroundFetch.unregisterTaskAsync(BACKGROUND_SYNC_TASK);
}
