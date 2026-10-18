#!/usr/bin/env node
/**
 * Generate grid thumbnails for job photos.
 *
 * WHY: the ~9.7k photos imported from Simpro are phone originals (3–8 MB each),
 * and the Photos tab grid on web and mobile used to download those originals
 * just to draw small squares. This makes a ~400px JPEG for each photo at
 * `<jobId>/thumbs/<file>` (lib/photo-thumbs.ts) in the same `job-photos`
 * bucket. Both apps use the thumbnail in the grid when it exists and fall back
 * to the original when it doesn't; the full-size viewer always opens the
 * original.
 *
 * ORIGINALS ARE NEVER TOUCHED. This script only downloads them and uploads a
 * new, separate object. It never deletes, moves or overwrites a photo, and it
 * writes nothing to the database.
 *
 * REQUIRES (in .env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * USAGE:
 *   node --env-file=.env.local scripts/generate-photo-thumbnails.mjs [options]
 *
 * OPTIONS:
 *   --commit          Upload thumbnails. Without it this is a DRY RUN: photos
 *                     are downloaded and resized in memory to prove they decode
 *                     and to measure the saving, and nothing is written.
 *   --limit=<n>       Only process the first n photos still needing a thumbnail.
 *   --concurrency=<n> Photos processed at once (default 4).
 *
 * Idempotent: a photo whose thumbnail already exists is skipped, so an
 * interrupted run can simply be started again. A report is written to
 * scripts/data/thumbnail-report-<dry-run|commit>-<timestamp>.json
 * (scripts/data is gitignored).
 */

import { createClient } from "@supabase/supabase-js";
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const argValue = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const LIMIT = argValue("limit") ? parseInt(argValue("limit"), 10) : Infinity;
const CONCURRENCY = argValue("concurrency") ? parseInt(argValue("concurrency"), 10) : 4;

const BUCKET = "job-photos";
const THUMB_DIR = "thumbs";
const THUMB_EDGE_PX = 400;
const THUMB_QUALITY = 70;

// Must match lib/photo-thumbs.ts / mobile/lib/photoThumbs.ts.
export function thumbPathFor(storagePath) {
  const slash = storagePath.indexOf("/");
  if (slash <= 0) return `${THUMB_DIR}/${storagePath}`;
  return `${storagePath.slice(0, slash)}/${THUMB_DIR}/${storagePath.slice(slash + 1)}`;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}. Run with: node --env-file=.env.local scripts/generate-photo-thumbnails.mjs`);
    process.exit(1);
  }
  return v;
}

async function withRetry(fn, what, attempts = 3) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts) await new Promise((r) => setTimeout(r, 1000 * i * i));
    }
  }
  throw new Error(`${what}: ${lastErr?.message ?? lastErr}`);
}

async function main() {
  const supabase = createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Every photo row, paged (PostgREST caps a response at 1000 rows).
  const photos = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("job_photos")
      .select("id, storage_path")
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(`reading job_photos: ${error.message}`);
    photos.push(...data.filter((p) => p.storage_path && !p.storage_path.includes(`/${THUMB_DIR}/`)));
    if (data.length < 1000) break;
  }

  // Which thumbnails already exist: list each job's thumbs/ folder once.
  const jobIds = [...new Set(photos.map((p) => p.storage_path.split("/")[0]))];
  const existing = new Set();
  for (const jobId of jobIds) {
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await withRetry(
        () => supabase.storage.from(BUCKET).list(`${jobId}/${THUMB_DIR}`, { limit: 1000, offset }),
        `listing ${jobId}/${THUMB_DIR}`
      );
      if (error) throw new Error(`listing ${jobId}/${THUMB_DIR}: ${error.message}`);
      for (const obj of data ?? []) existing.add(`${jobId}/${THUMB_DIR}/${obj.name}`);
      if (!data || data.length < 1000) break;
    }
  }

  const todo = photos.filter((p) => !existing.has(thumbPathFor(p.storage_path))).slice(0, LIMIT);
  console.log(
    `${photos.length} photos, ${photos.length - photos.filter((p) => !existing.has(thumbPathFor(p.storage_path))).length} already have a thumbnail, ` +
      `${todo.length} to process${COMMIT ? "" : " (DRY RUN — nothing will be written)"}.`
  );

  const report = { mode: COMMIT ? "commit" : "dry-run", started: new Date().toISOString(), done: 0, skippedExisting: 0, failed: [], originalBytes: 0, thumbBytes: 0 };
  let next = 0;
  const startedAt = Date.now();

  async function worker() {
    while (next < todo.length) {
      const photo = todo[next++];
      const thumbPath = thumbPathFor(photo.storage_path);
      try {
        const { data: blob, error: dlError } = await withRetry(
          () => supabase.storage.from(BUCKET).download(photo.storage_path),
          "download"
        );
        if (dlError) throw new Error(`download: ${dlError.message}`);
        const original = Buffer.from(await blob.arrayBuffer());
        // rotate(): bake EXIF orientation in, so portrait photos stay upright.
        const thumb = await sharp(original)
          .rotate()
          .resize(THUMB_EDGE_PX, THUMB_EDGE_PX, { fit: "inside", withoutEnlargement: true })
          .jpeg({ quality: THUMB_QUALITY, mozjpeg: true })
          .toBuffer();
        if (COMMIT) {
          // upsert: false — never overwrite. If a thumbnail appeared since the
          // listing (a parallel run), count it as already done.
          const { error: upError } = await withRetry(
            () => supabase.storage.from(BUCKET).upload(thumbPath, thumb, { contentType: "image/jpeg", upsert: false }),
            "upload"
          );
          if (upError && !/already exists|Duplicate/i.test(upError.message)) throw new Error(`upload: ${upError.message}`);
          if (upError) report.skippedExisting++;
        }
        report.originalBytes += original.length;
        report.thumbBytes += thumb.length;
        report.done++;
      } catch (err) {
        report.failed.push({ id: photo.id, storage_path: photo.storage_path, error: String(err?.message ?? err) });
      }
      const handled = report.done + report.failed.length;
      if (handled % 100 === 0 || handled === todo.length) {
        const rate = handled / ((Date.now() - startedAt) / 1000);
        const left = Math.round((todo.length - handled) / Math.max(rate, 0.01) / 60);
        console.log(`  ${handled}/${todo.length}  (${report.failed.length} failed, ~${left} min left)`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));

  report.finished = new Date().toISOString();
  const mb = (b) => (b / 1024 / 1024).toFixed(1);
  console.log(
    `\n${COMMIT ? "Uploaded" : "Would upload"} ${report.done} thumbnails. ` +
      `Originals ${mb(report.originalBytes)} MB → thumbnails ${mb(report.thumbBytes)} MB. ${report.failed.length} failed.`
  );
  if (report.failed.length) console.log("First failures:", report.failed.slice(0, 5));
  const outDir = path.join(__dirname, "data");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `thumbnail-report-${report.mode}-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`Report: ${path.relative(process.cwd(), outFile)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
