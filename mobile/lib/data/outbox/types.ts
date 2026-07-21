// The durable write-outbox model. Every mutation the app makes while it may be
// offline becomes an Operation persisted to SQLite and replayed (idempotently)
// by the processor when connectivity returns. This is the offline backbone of
// the `supabase-outbox` DataSource; a future PowerSync DataSource would replace
// it behind the same repository interfaces.

export type Aggregate =
  | "time_entry"
  | "job_photo"
  | "job"
  | "job_note"
  | "job_variation"
  | "backflow_test";

export type WriteOp = "insert" | "update" | "delete";

export type OpStatus = "pending" | "inflight" | "done" | "failed";

// A data mutation against a Supabase table.
export interface WriteOperation {
  kind: "write";
  id: string; // client-generated UUID = the row's PK for inserts (idempotent replay)
  aggregate: Aggregate;
  op: WriteOp;
  table: string;
  payload: Record<string, unknown>;
  /** Local file path for an attachment that must upload before this row inserts. */
  attachmentLocalPath?: string | null;
  /** Another operation id this one must run after (e.g. metadata after upload). */
  dependsOn?: string | null;
  status: OpStatus;
  attempts: number;
  nextAttemptAt: number; // epoch ms
  createdAt: number;
  error?: string | null;
}

// A deferred server-side side-effect (a Bearer web-API call). These are
// coalesced by `coalesceKey` so repeated triggers for the same entity collapse
// to one, and only the latest matters (e.g. re-syncing a job's billing).
export type SideEffectKind =
  | "sync-billing"
  | "sync-calendar"
  | "transcribe-voice-report"
  | "backflow-submit";

export interface SideEffectOperation {
  kind: "side_effect";
  id: string;
  effect: SideEffectKind;
  coalesceKey: string; // e.g. `sync-billing:${entryId}` — dedupes queued duplicates
  payload: Record<string, unknown>;
  dependsOn?: string | null;
  status: OpStatus;
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  error?: string | null;
}

export type Operation = WriteOperation | SideEffectOperation;

export function isWrite(op: Operation): op is WriteOperation {
  return op.kind === "write";
}
export function isSideEffect(op: Operation): op is SideEffectOperation {
  return op.kind === "side_effect";
}
