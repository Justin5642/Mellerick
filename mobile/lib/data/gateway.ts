// The narrow boundary between the offline layer and the outside world. The
// processor talks only to this interface, so tests mock a small, honest seam
// instead of the supabase-js fluent chain. The real implementation
// (gateway.supabase.ts) wraps supabase-js + Storage + the Bearer web-API calls.
import type { SideEffectKind } from "./outbox/types";

export interface SupabaseGateway {
  // Idempotent upsert keyed on the row's client-generated id.
  upsertRow(table: string, row: Record<string, unknown>): Promise<void>;
  updateRow(table: string, id: string, patch: Record<string, unknown>): Promise<void>;
  // Deletes treat "not found" as success (idempotent).
  deleteRow(table: string, id: string): Promise<void>;
  // Upload a local file to Supabase Storage; returns the storage path.
  uploadObject(bucket: string, path: string, localUri: string): Promise<void>;
  // Remove a Storage object. Best-effort: never throws (mirrors the web app's
  // unchecked storage.remove; the job-photos bucket has no DELETE policy yet, so
  // this is RLS-denied today — throwing would wedge every photo delete).
  removeObject(bucket: string, path: string): Promise<void>;
  // Best-effort delete of a queued local attachment after it has synced, so the
  // outbox attachment directory doesn't grow without bound. Never throws.
  cleanupAttachment(localUri: string): Promise<void>;
}

export interface ApiBridge {
  // Fire a deferred server-side side-effect (the Bearer web-API endpoints).
  callSideEffect(effect: SideEffectKind, payload: Record<string, unknown>): Promise<void>;
}
