// THE ONLY FILE that may import @powersync/react-native (and therefore
// op-sqlite). Everything else — connector, schema, seam, provider logic —
// imports from @powersync/common or lib/data/reads/source, both pure JS.
// test/powersyncNativeGuard.js enforces this for the test suite.
import { PowerSyncDatabase } from "@powersync/react-native";
import { AppSchema } from "../lib/powersync/schema";
import type { LocalReads, LocalRole } from "../lib/data/reads/source";

export const powersync = new PowerSyncDatabase({
  schema: AppSchema,
  database: { dbFilename: "mellerick-powersync.db" },
});

/**
 * Adapts the PowerSync database to the narrow LocalReads seam. The role is
 * captured at connect time by the provider — the local row set was synced
 * under that role, so reads must be judged against it, not against whatever
 * the profile changes to later.
 */
export function makeLocalReads(role: () => LocalRole): LocalReads {
  return {
    hasSynced: () => powersync.currentStatus.hasSynced === true,
    role,
    getAll: (sql, params) => powersync.getAll(sql, params as unknown[]),
    getOptional: (sql, params) => powersync.getOptional(sql, params as unknown[]),
  };
}
