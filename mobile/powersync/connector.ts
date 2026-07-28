// PowerSync backend connector — pure logic, no native imports, fully testable.
//
// fetchCredentials: the instance has "Use Supabase Auth" enabled, so the
// client authenticates with the user's Supabase access token directly.
//
// uploadData: PowerSync is READ-ONLY in this app — every write goes through
// the durable SQLite outbox (lib/data/outbox) to Supabase, never through
// PowerSync CRUD. If a CRUD entry ever appears here it is a routing bug:
// drain it (an uncompleted entry would stall the download loop forever) and
// make it loud.
import type {
  CommonPowerSyncDatabase,
  PowerSyncBackendConnector,
  PowerSyncCredentials,
} from "@powersync/common";

export const POWERSYNC_URL = "https://6a5f0bf6367771958b496c5e.powersync.journeyapps.com";

export interface SessionSource {
  /** Returns the CURRENT Supabase access token, refreshing if needed; null when signed out. */
  getAccessToken(): Promise<{ token: string; expiresAt: Date | null } | null>;
}

export type ReadOnlyViolationListener = (detail: string) => void;

export class MellerickConnector implements PowerSyncBackendConnector {
  constructor(
    private readonly sessions: SessionSource,
    private readonly onViolation: ReadOnlyViolationListener,
    private readonly endpoint: string = POWERSYNC_URL
  ) {}

  fetchCredentials = async (): Promise<PowerSyncCredentials | null> => {
    const session = await this.sessions.getAccessToken();
    if (!session) return null;
    return {
      endpoint: this.endpoint,
      token: session.token,
      ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
    };
  };

  uploadData = async (db: CommonPowerSyncDatabase): Promise<void> => {
    const tx = await db.getNextCrudTransaction();
    if (!tx) return;
    const detail = tx.crud.map((e) => `${e.op} ${e.table}#${e.id}`).join(", ");
    // Complete FIRST — an uncompleted head-of-queue entry wedges the sync loop.
    await tx.complete();
    this.onViolation(detail);
    if (__DEV__) {
      throw new Error(`PowerSync is READ-ONLY in this app; unexpected CRUD: ${detail}`);
    }
  };
}
