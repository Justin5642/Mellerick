import * as FileSystem from "expo-file-system/legacy";
import { decode } from "base64-arraybuffer";
import { supabase } from "../supabase";
import type { SupabaseGateway, ApiBridge } from "./gateway";
import type { SideEffectKind } from "./outbox/types";
import { OUTBOX_ATTACHMENT_DIR } from "./attachments";

// Real gateway: the processor's writes hit Supabase through here. All reads
// still go through supabase-js elsewhere, so RLS + the rate-stripped views
// remain the authorization boundary (no second authz surface — the reason we
// chose the outbox over PowerSync for this app).
export const supabaseGateway: SupabaseGateway = {
  async insertRow(table, row) {
    const { error } = await supabase.from(table).insert(row);
    if (!error) return;
    // 23505 = unique_violation, and it means two very different things here.
    //
    // PRIMARY KEY violated → this is the outbox replaying a write that already
    // landed (we never saw the first response). Report success WITHOUT
    // overwriting whatever the row holds now — that is the idempotency the
    // durable outbox depends on.
    //
    // SECONDARY unique constraint violated (inventory.sku, variation_types.name)
    // → a genuinely NEW row collided with a DIFFERENT existing one. Nothing was
    // written. Swallowing it would mark the operation done and lose the record
    // silently, with the user believing they had saved it. Surface it.
    if (error.code === "23505" && isReplayOfSameRow(table, error.message)) return;
    throw new Error(`${table} insert: ${error.message}`);
  },
  async updateRow(table, id, patch) {
    // `count: "exact"` because A WRITE THAT AFFECTED NO ROWS IS NOT A WRITE.
    //
    // PostgREST does not return an error when an UPDATE matches nothing: RLS
    // filters the row out and the statement succeeds against zero rows. Checking
    // only `error` therefore reported success for an edit that never happened —
    // the processor marked the operation done and removed it from the outbox,
    // leaving no error, no dead letter and no badge. The same shape as the
    // geofence and clock-in defects: asking "did it fail?" when the question is
    // "did it happen?".
    const { error, count } = await supabase
      .from(table)
      .update(patch, { count: "exact" })
      .eq("id", id);
    if (error) throw new Error(`${table} update: ${error.message}`);

    // An ABSENT count is not zero. Some PostgREST configurations omit the
    // header, and treating that as failure would dead-letter every healthy
    // write — worse than the bug being fixed. Only an explicit zero is a loss.
    if (count === 0) {
      throw new Error(
        `${table} update affected no rows (id ${id}) — the row is missing or RLS denied it. ` +
          `Failing rather than reporting success, so the operation is retried and surfaced instead of vanishing.`
      );
    }
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
    // storage.remove(). Migration 0037 IS applied (verified against pg_policies
    // 2026-07-28), so job-photos/job-audio deletes now genuinely remove the
    // object rather than being RLS-denied. Staying best-effort regardless: a
    // storage hiccup must never dead-letter the row delete behind it, and
    // "not found" is success on an idempotent replay.
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
  async listStagedAttachments() {
    // Best-effort inventory of the staging directory. Housekeeping only, so any
    // failure — directory absent on a fresh install, permissions, a file that
    // vanished between the listing and the stat — degrades to "reclaim nothing
    // this pass" rather than disturbing the drain.
    try {
      const names = await FileSystem.readDirectoryAsync(OUTBOX_ATTACHMENT_DIR);
      const files = await Promise.all(
        names.map(async (name) => {
          const uri = `${OUTBOX_ATTACHMENT_DIR}${name}`;
          try {
            const info = await FileSystem.getInfoAsync(uri);
            if (!info.exists || info.isDirectory) return null;
            // modificationTime is SECONDS in expo-file-system; the selector works
            // in ms. A missing value becomes "now", which keeps the file — the
            // safe direction.
            const modifiedAt = info.modificationTime ? info.modificationTime * 1000 : Date.now();
            return { uri, modifiedAt };
          } catch {
            return null;
          }
        })
      );
      return files.filter((f): f is { uri: string; modifiedAt: number } => f !== null);
    } catch {
      return [];
    }
  },
};

/**
 * True when a unique_violation names a PRIMARY KEY constraint — i.e. the same
 * row is being inserted twice, which is exactly what an outbox replay looks
 * like. Postgres reports these as `<table>_pkey`.
 *
 * When the constraint cannot be identified we treat it as a replay: the cost is
 * at worst one lost row in an ambiguous case, whereas throwing would dead-letter
 * a legitimately-replayed write forever and block the whole queue behind it.
 *
 * That ambiguous branch is the only path on which a write disappears without
 * surfacing an error, so it warns unconditionally — a report of a missing row is
 * otherwise impossible to attribute after the fact.
 */
function isReplayOfSameRow(table: string, message: string): boolean {
  const named = message.match(/constraint "([^"]+)"/);
  if (!named) {
    console.warn(`[outbox] ${table}: unique violation with no constraint name — assuming replay, row dropped:`, message);
    return true;
  }
  return named[1].endsWith("_pkey");
}

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
  "sync-job-billing": (p) => `/api/jobs/${p.jobId}/sync-billing`,
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
