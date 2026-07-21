import * as FileSystem from "expo-file-system/legacy";
import { decode } from "base64-arraybuffer";
import { supabase } from "../supabase";
import type { SupabaseGateway, ApiBridge } from "./gateway";
import type { SideEffectKind } from "./outbox/types";

// Real gateway: the processor's writes hit Supabase through here. All reads
// still go through supabase-js elsewhere, so RLS + the rate-stripped views
// remain the authorization boundary (no second authz surface — the reason we
// chose the outbox over PowerSync for this app).
export const supabaseGateway: SupabaseGateway = {
  async upsertRow(table, row) {
    const { error } = await supabase.from(table).upsert(row, { onConflict: "id" });
    if (error) throw new Error(`${table} upsert: ${error.message}`);
  },
  async updateRow(table, id, patch) {
    const { error } = await supabase.from(table).update(patch).eq("id", id);
    if (error) throw new Error(`${table} update: ${error.message}`);
  },
  async deleteRow(table, id) {
    const { error } = await supabase.from(table).delete().eq("id", id);
    // A missing row on replay is success (idempotent delete).
    if (error && !/not found/i.test(error.message)) throw new Error(`${table} delete: ${error.message}`);
  },
  async uploadObject(bucket, path, localUri) {
    const base64 = await FileSystem.readAsStringAsync(localUri, { encoding: FileSystem.EncodingType.Base64 });
    const { error } = await supabase.storage.from(bucket).upload(path, decode(base64), {
      contentType: guessContentType(path),
      upsert: true, // idempotent re-upload on replay
    });
    if (error) throw new Error(`storage ${bucket}/${path}: ${error.message}`);
  },
  async removeObject(bucket, path) {
    // Best-effort, never throws — mirrors the web app's unchecked
    // storage.remove(). The job-photos bucket has no Storage DELETE policy yet
    // (see DECISIONS D12), so this is RLS-denied today and objects orphan; if we
    // threw, every offline photo delete would fail forever and never delete the
    // row. When a DELETE policy lands this starts actually removing objects with
    // no code change. "Not found" is likewise success (idempotent replay).
    try {
      await supabase.storage.from(bucket).remove([path]);
    } catch {
      // ignore — object cleanup must never block the row delete
    }
  },
  async cleanupAttachment(localUri) {
    // Best-effort: a leftover local file must never fail or block a synced write.
    try {
      await FileSystem.deleteAsync(localUri, { idempotent: true });
    } catch {
      // ignore — orphaned temp file at worst
    }
  },
};

function guessContentType(path: string): string {
  if (/\.png$/i.test(path)) return "image/png";
  if (/\.jpe?g$/i.test(path)) return "image/jpeg";
  if (/\.(m4a|mp4|aac)$/i.test(path)) return "audio/mp4";
  return "application/octet-stream";
}

// Bearer web-API bridge for deferred server-side side-effects. Attaches the
// current Supabase access token; a null API base (dev without the web server)
// makes calls no-op rather than throw, mirroring the existing app pattern.
const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;

const sideEffectPath: Record<SideEffectKind, (p: Record<string, unknown>) => string> = {
  "sync-billing": (p) => `/api/time-entries/${p.entryId}/sync-billing`,
  "sync-calendar": (p) => `/api/jobs/${p.jobId}/sync-calendar`,
  "transcribe-voice-report": (p) => `/api/jobs/${p.jobId}/transcribe-voice-report`,
  "backflow-submit": (p) => `/api/backflow/tests/${p.testId}/submit`,
};

export const apiBridge: ApiBridge = {
  async callSideEffect(effect, payload) {
    if (!API_BASE_URL) return; // degrade gracefully when the web API isn't configured
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    const res = await fetch(`${API_BASE_URL}${sideEffectPath[effect](payload)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`${effect}: HTTP ${res.status}`);
  },
};
