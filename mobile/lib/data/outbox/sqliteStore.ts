import * as SQLite from "expo-sqlite";
import type { Operation, OpStatus } from "./types";
import type { OutboxStore } from "./store";

// Durable SQLite implementation of the OutboxStore — the outbox survives app
// restarts and cold starts so a queued clock-in/photo/note is never lost. The
// Operation is stored with its dynamic bits (payload) as JSON text. The queue
// logic (outbox.ts, unit-tested against InMemoryOutboxStore) is unchanged; this
// is just the persistence adapter, exercised by integration/e2e tests.

const CREATE = `
  CREATE TABLE IF NOT EXISTS outbox (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    coalesce_key TEXT,
    depends_on TEXT,
    attachment_local_path TEXT,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    error TEXT,
    data TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS outbox_status_idx ON outbox(status, next_attempt_at);
  CREATE INDEX IF NOT EXISTS outbox_coalesce_idx ON outbox(coalesce_key);
`;

interface Row {
  id: string;
  kind: string;
  coalesce_key: string | null;
  depends_on: string | null;
  attachment_local_path: string | null;
  status: string;
  attempts: number;
  next_attempt_at: number;
  created_at: number;
  error: string | null;
  data: string;
}

function rowToOp(r: Row): Operation {
  // `data` holds the fields not promoted to columns (payload, aggregate/op/table
  // or effect). Column values are authoritative for the queue fields.
  const data = JSON.parse(r.data) as Record<string, unknown>;
  return {
    ...data,
    id: r.id,
    kind: r.kind,
    status: r.status as OpStatus,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    createdAt: r.created_at,
    dependsOn: r.depends_on,
    error: r.error,
    ...(r.kind === "side_effect" ? { coalesceKey: r.coalesce_key } : {}),
    ...(r.kind === "write" ? { attachmentLocalPath: r.attachment_local_path } : {}),
  } as Operation;
}

// One store per process, keyed by filename.
//
// expo-sqlite hands back a SHARED native object per database file: opening the
// same file twice yields two JS handles onto ONE native object, not two
// connections. When either handle is released — a Fast Refresh, a provider
// remount, React's dev double-mount — the others point at freed memory and the
// next query dies with "Cannot use shared object that was already released"
// (expo.modules.sqlite.NativeStatement). DataProvider opens the store inside a
// useEffect, so any remount used to trigger exactly that.
//
// Caching the PROMISE (not the resolved store) also collapses a race where two
// callers open concurrently. A rejected attempt is evicted so a transient
// failure cannot leave the outbox permanently unusable.
const openStores = new Map<string, Promise<SqliteOutboxStore>>();

/** Test seam: drop cached handles so each test opens fresh. */
export function __resetOutboxStoreForTests(): void {
  openStores.clear();
}

export class SqliteOutboxStore implements OutboxStore {
  private constructor(private db: SQLite.SQLiteDatabase) {}

  static open(name = "mellerick-outbox.db"): Promise<SqliteOutboxStore> {
    const existing = openStores.get(name);
    if (existing) return existing;

    const opening = (async () => {
      const db = await SQLite.openDatabaseAsync(name);
      await db.execAsync(CREATE);
      return new SqliteOutboxStore(db);
    })().catch((e) => {
      openStores.delete(name); // never cache a failure
      throw e;
    });

    openStores.set(name, opening);
    return opening;
  }

  async insert(op: Operation): Promise<void> {
    const coalesceKey = op.kind === "side_effect" ? op.coalesceKey : null;
    const attachment = op.kind === "write" ? op.attachmentLocalPath ?? null : null;
    await this.db.runAsync(
      `INSERT OR REPLACE INTO outbox
        (id, kind, coalesce_key, depends_on, attachment_local_path, status, attempts, next_attempt_at, created_at, error, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      op.id,
      op.kind,
      coalesceKey,
      op.dependsOn ?? null,
      attachment,
      op.status,
      op.attempts,
      op.nextAttemptAt,
      op.createdAt,
      op.error ?? null,
      JSON.stringify(op)
    );
  }

  async update(id: string, patch: Partial<Operation>): Promise<void> {
    const existing = await this.db.getFirstAsync<Row>("SELECT * FROM outbox WHERE id = ?", id);
    if (!existing) return;
    const merged = { ...rowToOp(existing), ...patch } as Operation;
    await this.insert(merged);
  }

  async all(): Promise<Operation[]> {
    const rows = await this.db.getAllAsync<Row>("SELECT * FROM outbox ORDER BY created_at ASC");
    return rows.map(rowToOp);
  }

  async findByCoalesceKey(key: string): Promise<Operation | undefined> {
    // Only coalesce onto a not-yet-dispatching op (pending/failed). Coalescing
    // onto an "inflight" op would be clobbered by its in-flight dispatch's
    // markDone; a "dead" op is terminal and must not be revived.
    const row = await this.db.getFirstAsync<Row>(
      "SELECT * FROM outbox WHERE coalesce_key = ? AND status IN ('pending', 'failed') LIMIT 1",
      key
    );
    return row ? rowToOp(row) : undefined;
  }

  async countByStatus(status: OpStatus): Promise<number> {
    const row = await this.db.getFirstAsync<{ n: number }>(
      "SELECT COUNT(*) as n FROM outbox WHERE status = ?",
      status
    );
    return row?.n ?? 0;
  }
}
