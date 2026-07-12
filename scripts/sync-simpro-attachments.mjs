#!/usr/bin/env node
/**
 * Simpro job attachment (photos/plans/documents) sync — direct API version.
 *
 * WHY THIS EXISTS: the Simpro MCP tool used to migrate job records
 * (see migrate-simpro-jobs.mjs) has no attachments endpoint, so none of
 * the migrated jobs have photos/documents. This script talks to Simpro's
 * REST API directly using a personal access token, for the sole purpose
 * of pulling attachment files and loading them into the app's existing
 * `job_photos` / `job_documents` tables + `job-photos` / `job-documents`
 * Supabase Storage buckets.
 *
 * REQUIRES (in .env.local):
 *   SIMPRO_BUILD_URL     e.g. https://mellerick.simprosuite.com
 *   SIMPRO_ACCESS_TOKEN  personal access token (Setup > Security > OAuth2/API Access)
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * REQUIRES the migration in supabase/migrations/0002_add_simpro_attachment_ids.sql
 * to have been run first (adds simpro_file_id to job_photos/job_documents so
 * re-runs don't create duplicates).
 *
 * USAGE:
 *   node --env-file=.env.local scripts/sync-simpro-attachments.mjs [options]
 *
 * OPTIONS:
 *   --commit       Actually upload files + write DB rows. Without this flag,
 *                   the script only lists + downloads (to measure real size/
 *                   type) and prints/saves a dry-run report — nothing is
 *                   written to Storage or the database.
 *   --limit=<n>     Only process the first n jobs (of those with a
 *                   simpro_job_id set). Useful for a small test batch.
 *   --job=<id>      Only process this one Simpro job ID. Useful for testing.
 *   --jobs=<ids>    Only process these Simpro job IDs (comma-separated).
 *                   Useful for retrying a specific set of failures from a
 *                   previous report without re-scanning every job.
 *
 * Classification: files with an image/* content-type go to job_photos
 * (photo_type = 'general'); everything else (PDF, Word, DWG, DXF, Excel,
 * etc.) goes to job_documents.
 *
 * RELIABILITY: a large batch (800+ jobs) can make Simpro's API start
 * dropping connections partway through ("fetch failed" / "terminated" —
 * Node-level network errors, not HTTP error statuses) rather than a clean
 * 429. Confirmed this happens under sustained back-to-back requests and
 * degrades progressively (occasional download failures first, then whole
 * jobs failing to even list). simproFetch() below retries transient
 * network errors with backoff, and there's a small delay between jobs to
 * avoid re-triggering it.
 */

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- CLI args ----------
const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : Infinity;
const jobArg = args.find((a) => a.startsWith("--job="));
const ONLY_JOB_ID = jobArg ? parseInt(jobArg.split("=")[1], 10) : null;
const jobsArg = args.find((a) => a.startsWith("--jobs="));
const ONLY_JOB_IDS = jobsArg
  ? jobsArg
      .split("=")[1]
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !Number.isNaN(n))
  : null;

// ---------- Env / clients ----------
const SIMPRO_BUILD_URL = process.env.SIMPRO_BUILD_URL;
const SIMPRO_ACCESS_TOKEN = process.env.SIMPRO_ACCESS_TOKEN;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SIMPRO_BUILD_URL || !SIMPRO_ACCESS_TOKEN) {
  console.error("Missing SIMPRO_BUILD_URL or SIMPRO_ACCESS_TOKEN in .env.local");
  process.exit(1);
}
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const SIMPRO_COMPANY_ID = 0; // confirmed via GET /api/v1.0/companies/

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Simpro's API drops connections outright ("fetch failed"/"terminated" —
// thrown by fetch() itself, not an HTTP error response) under sustained
// load rather than returning a clean 429. Retry those a few times with
// backoff before giving up; a real HTTP error status is returned as-is
// (callers already handle non-ok responses explicitly).
async function simproFetch(urlPath, attempt = 1) {
  const MAX_ATTEMPTS = 4;
  try {
    const res = await fetch(`${SIMPRO_BUILD_URL}${urlPath}`, {
      headers: { Authorization: `Bearer ${SIMPRO_ACCESS_TOKEN}` },
    });
    return res;
  } catch (err) {
    if (attempt >= MAX_ATTEMPTS) throw err;
    const backoffMs = 500 * 2 ** (attempt - 1);
    await sleep(backoffMs);
    return simproFetch(urlPath, attempt + 1);
  }
}

async function listAttachmentFiles(simproJobId) {
  const files = [];
  let page = 1;
  const pageSize = 250;
  while (true) {
    const res = await simproFetch(
      `/api/v1.0/companies/${SIMPRO_COMPANY_ID}/jobs/${simproJobId}/attachments/files/?page=${page}&pageSize=${pageSize}`
    );
    if (res.status === 404) return files; // job has no attachments section at all
    if (!res.ok) throw new Error(`listAttachmentFiles ${simproJobId} page ${page}: HTTP ${res.status}`);
    const batch = await res.json();
    files.push(...batch);
    const totalPages = parseInt(res.headers.get("result-pages") || "1", 10);
    if (page >= totalPages || batch.length === 0) break;
    page++;
  }
  return files;
}

async function downloadAttachmentFile(simproJobId, fileId) {
  const res = await simproFetch(
    `/api/v1.0/companies/${SIMPRO_COMPANY_ID}/jobs/${simproJobId}/attachments/files/${encodeURIComponent(fileId)}/view/`
  );
  if (!res.ok) throw new Error(`downloadAttachmentFile ${simproJobId}/${fileId}: HTTP ${res.status}`);
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  const arrayBuffer = await res.arrayBuffer();
  return { buffer: Buffer.from(arrayBuffer), contentType };
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isImage(contentType) {
  return contentType.startsWith("image/");
}

// ---------- Report ----------
const report = {
  mode: COMMIT ? "COMMIT" : "DRY RUN",
  jobsProcessed: 0,
  filesListed: 0,
  photosCreated: [],
  documentsCreated: [],
  skippedAlreadySynced: 0,
  errors: [],
  totalBytes: 0,
};

async function main() {
  console.log(`\nSimpro attachment sync — ${report.mode}`);

  // ---------- Load jobs to process ----------
  let query = supabase.from("jobs").select("id, simpro_job_id").not("simpro_job_id", "is", null);
  if (ONLY_JOB_ID) query = query.eq("simpro_job_id", ONLY_JOB_ID);
  if (ONLY_JOB_IDS) query = query.in("simpro_job_id", ONLY_JOB_IDS);
  const { data: jobs, error: jobsErr } = await query.order("simpro_job_id", { ascending: true });
  if (jobsErr) throw jobsErr;
  const jobsToProcess = jobs.slice(0, LIMIT);
  console.log(`Jobs with simpro_job_id in Supabase: ${jobs.length}. Processing: ${jobsToProcess.length}.\n`);

  // ---------- Preload already-synced simpro_file_ids for idempotency ----------
  const syncedFileIds = new Set();
  for (const table of ["job_photos", "job_documents"]) {
    const { data, error } = await supabase.from(table).select("simpro_file_id").not("simpro_file_id", "is", null);
    if (error) {
      if (error.message?.includes("simpro_file_id")) {
        console.error(
          `\n"${table}" has no simpro_file_id column yet. Run supabase/migrations/0002_add_simpro_attachment_ids.sql first.\n`
        );
        process.exit(1);
      }
      throw error;
    }
    for (const row of data) syncedFileIds.add(row.simpro_file_id);
  }
  console.log(`Already-synced files (from a previous run): ${syncedFileIds.size}\n`);

  for (const job of jobsToProcess) {
    if (report.jobsProcessed > 0) await sleep(120); // pace requests to avoid tripping Simpro's connection drops
    report.jobsProcessed++;
    let files;
    try {
      files = await listAttachmentFiles(job.simpro_job_id);
    } catch (err) {
      report.errors.push({ simproJobId: job.simpro_job_id, stage: "list", message: err.message });
      continue;
    }
    report.filesListed += files.length;
    if (files.length === 0) continue;

    for (const file of files) {
      if (syncedFileIds.has(file.ID)) {
        report.skippedAlreadySynced++;
        continue;
      }

      let downloaded;
      try {
        downloaded = await downloadAttachmentFile(job.simpro_job_id, file.ID);
      } catch (err) {
        report.errors.push({
          simproJobId: job.simpro_job_id,
          fileId: file.ID,
          filename: file.Filename,
          stage: "download",
          message: err.message,
        });
        continue;
      }

      report.totalBytes += downloaded.buffer.length;
      const photo = isImage(downloaded.contentType);
      const bucket = photo ? "job-photos" : "job-documents";
      const storagePath = `${job.id}/simpro-${file.ID}-${sanitizeFilename(file.Filename)}`;

      const record = {
        simproJobId: job.simpro_job_id,
        fileId: file.ID,
        filename: file.Filename,
        contentType: downloaded.contentType,
        bytes: downloaded.buffer.length,
        storagePath,
      };
      (photo ? report.photosCreated : report.documentsCreated).push(record);

      if (COMMIT) {
        const { error: uploadErr } = await supabase.storage
          .from(bucket)
          .upload(storagePath, downloaded.buffer, { contentType: downloaded.contentType, upsert: false });
        if (uploadErr) {
          report.errors.push({ ...record, stage: "upload", message: uploadErr.message });
          continue;
        }

        const dbPayload = photo
          ? {
              job_id: job.id,
              storage_path: storagePath,
              photo_type: "general",
              caption: file.Filename,
              simpro_file_id: file.ID,
            }
          : {
              job_id: job.id,
              storage_path: storagePath,
              file_name: file.Filename,
              file_size: downloaded.buffer.length,
              file_type: downloaded.contentType,
              simpro_file_id: file.ID,
            };
        const { error: dbErr } = await supabase.from(photo ? "job_photos" : "job_documents").insert(dbPayload);
        if (dbErr) {
          report.errors.push({ ...record, stage: "db-insert", message: dbErr.message });
        }
      }
    }
  }

  // ---------- Print + save report ----------
  const summary = {
    mode: report.mode,
    jobsProcessed: report.jobsProcessed,
    filesListed: report.filesListed,
    photosCreated: report.photosCreated.length,
    documentsCreated: report.documentsCreated.length,
    skippedAlreadySynced: report.skippedAlreadySynced,
    errors: report.errors.length,
    totalMB: (report.totalBytes / (1024 * 1024)).toFixed(1),
  };
  console.table(summary);

  if (report.errors.length > 0) {
    console.log("\n⚠ Errors:");
    console.log(JSON.stringify(report.errors.slice(0, 20), null, 2));
    if (report.errors.length > 20) console.log(`...and ${report.errors.length - 20} more (see full report file).`);
  }

  const reportPath = path.join(__dirname, "data", `attachment-sync-report-${COMMIT ? "commit" : "dryrun"}-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nFull report written to ${reportPath}`);
  if (!COMMIT) {
    console.log("\nThis was a DRY RUN — files were downloaded to measure size/type but nothing was written to Supabase. Re-run with --commit to apply.");
  }
}

main().catch((err) => {
  console.error("Attachment sync failed:", err);
  process.exit(1);
});
