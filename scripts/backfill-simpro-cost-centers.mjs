#!/usr/bin/env node
/**
 * Simpro job cost center backfill — direct API version.
 *
 * WHY THIS EXISTS: the original job migration (migrate-simpro-jobs.mjs)
 * only extracted 13 flat fields per job (id, customer, site, name, notes,
 * total, dates, status) — it never pulled Simpro's Sections/Cost Centers
 * breakdown, so none of the 500 imported jobs have a Purchase Order or
 * cost center split in the app. Same reasoning as sync-simpro-attachments.mjs:
 * the Simpro MCP tool's jobs_get doesn't expose Sections/Cost Centers either,
 * so this talks to Simpro's REST API directly using a personal access token.
 *
 * For each already-imported job (jobs.simpro_job_id is set), this:
 *   1. Lists the job's Sections (GET /jobs/{id}/sections/)
 *   2. Lists each section's Cost Centers (GET /jobs/{id}/sections/{id}/costCenters/)
 *   3. Fetches each cost center's detail (GET .../costCenters/{id}, no trailing
 *      slash) to read its ResourcesCost.LaborHours (Estimate, falling back to
 *      Actual when no estimate was ever set in Simpro)
 *   4. Creates one `purchase_orders` row per job (po_number = "SIMPRO-<jobId>")
 *      and one `po_cost_centers` row per Simpro cost center under it — this
 *      reuses the existing Purchase Orders / Cost Centers UI
 *      (components/job/job-po.tsx) with no app changes needed.
 *
 * REQUIRES (in .env.local):
 *   SIMPRO_BUILD_URL     e.g. https://mellerick.simprosuite.com
 *   SIMPRO_ACCESS_TOKEN  personal access token (Setup > Security > OAuth2/API Access)
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * REQUIRES the migration in supabase/migrations/0060_add_simpro_cost_center_ids.sql
 * to have been run first (adds simpro_job_id to purchase_orders and
 * simpro_cost_center_id to po_cost_centers so re-runs don't create duplicates).
 *
 * USAGE:
 *   node --env-file=.env.local scripts/backfill-simpro-cost-centers.mjs [options]
 *
 * OPTIONS:
 *   --commit       Actually write to Supabase. Without this flag, the script
 *                   only lists cost centers and prints/saves a dry-run
 *                   report — nothing is inserted.
 *   --limit=<n>     Only process the first n jobs (of those with a
 *                   simpro_job_id set). Useful for a small test batch.
 *   --job=<id>      Only process this one Simpro job ID. Useful for testing.
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

// Simpro's API drops connections outright ("fetch failed"/"terminated") under
// sustained load rather than returning a clean 429 — same behavior observed
// in sync-simpro-attachments.mjs. Retry transient network errors with backoff.
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

async function simproGetJson(urlPath) {
  const res = await simproFetch(urlPath);
  if (!res.ok) {
    throw new Error(`Simpro API ${res.status} on ${urlPath}`);
  }
  return res.json();
}

/** Fetch every cost center (flattened across all sections) for a Simpro job. */
async function fetchJobCostCenters(simproJobId) {
  const sections = await simproGetJson(
    `/api/v1.0/companies/${SIMPRO_COMPANY_ID}/jobs/${simproJobId}/sections/`
  );

  const costCenters = [];
  for (const section of sections) {
    const list = await simproGetJson(
      `/api/v1.0/companies/${SIMPRO_COMPANY_ID}/jobs/${simproJobId}/sections/${section.ID}/costCenters/`
    );
    for (const cc of list) {
      const detail = await simproGetJson(
        `/api/v1.0/companies/${SIMPRO_COMPANY_ID}/jobs/${simproJobId}/sections/${section.ID}/costCenters/${cc.ID}`
      );
      const laborHours = detail?.Totals?.ResourcesCost?.LaborHours;
      const allocatedHours = laborHours ? laborHours.Estimate || laborHours.Actual || 0 : 0;
      costCenters.push({
        simproCostCenterId: cc.ID,
        name: (cc.Name || cc.CostCenter?.Name || `Cost Center #${cc.ID}`).trim(),
        allocatedAmount: cc.Total?.ExTax ?? 0,
        allocatedHours,
        sortOrder: costCenters.length,
      });
    }
  }
  return costCenters;
}

// ---------- Report accumulator ----------
const report = {
  mode: COMMIT ? "COMMIT" : "DRY RUN",
  processed: 0,
  posCreated: [],
  skippedAlreadyBackfilled: [],
  skippedNoCostCenters: [],
  errors: [],
};

async function main() {
  console.log(`\nSimpro cost center backfill — ${report.mode}\n`);

  // PostgREST caps unbounded selects at 1000 rows, so a single query silently
  // truncates once the jobs table passes that — page through with .range()
  // to get every job regardless of table size.
  const jobs = [];
  const PAGE_SIZE = 1000;
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = supabase
      .from("jobs")
      .select("id, title, simpro_job_id")
      .not("simpro_job_id", "is", null)
      .order("simpro_job_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (ONLY_JOB_ID) query = query.eq("simpro_job_id", ONLY_JOB_ID);

    const { data: page, error: jobsErr } = await query;
    if (jobsErr) throw jobsErr;
    jobs.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  const jobsToProcess = jobs.slice(0, LIMIT);
  console.log(`Found ${jobs.length} imported Simpro jobs, processing ${jobsToProcess.length}\n`);

  for (const job of jobsToProcess) {
    report.processed++;

    const { data: existingPo, error: existingErr } = await supabase
      .from("purchase_orders")
      .select("id")
      .eq("simpro_job_id", job.simpro_job_id)
      .maybeSingle();
    if (existingErr) throw existingErr;
    if (existingPo) {
      report.skippedAlreadyBackfilled.push(job.simpro_job_id);
      continue;
    }

    let costCenters;
    try {
      costCenters = await fetchJobCostCenters(job.simpro_job_id);
    } catch (err) {
      report.errors.push({ simproJobId: job.simpro_job_id, error: String(err) });
      console.error(`  ✗ job ${job.simpro_job_id}: ${err}`);
      continue;
    }

    if (costCenters.length === 0) {
      report.skippedNoCostCenters.push(job.simpro_job_id);
      continue;
    }

    const totalValue = costCenters.reduce((sum, c) => sum + c.allocatedAmount, 0);
    const totalHours = costCenters.reduce((sum, c) => sum + c.allocatedHours, 0);

    const poPayload = {
      job_id: job.id,
      simpro_job_id: job.simpro_job_id,
      po_number: `SIMPRO-${job.simpro_job_id}`,
      notes: `Cost centers imported from Simpro job #${job.simpro_job_id}.`,
      total_value: totalValue,
      total_hours: totalHours,
    };

    report.posCreated.push({
      simproJobId: job.simpro_job_id,
      jobTitle: job.title,
      costCenters: costCenters.map((c) => ({ name: c.name, amount: c.allocatedAmount, hours: c.allocatedHours })),
    });

    console.log(
      `  ${COMMIT ? "created" : "would create"} PO for job ${job.simpro_job_id} (${job.title}) — ${costCenters.length} cost centers, $${totalValue.toFixed(2)}`
    );

    if (COMMIT) {
      const { data: po, error: poErr } = await supabase
        .from("purchase_orders")
        .insert(poPayload)
        .select("id")
        .single();
      if (poErr) throw poErr;

      const ccPayload = costCenters.map((c) => ({
        po_id: po.id,
        simpro_cost_center_id: c.simproCostCenterId,
        name: c.name,
        allocated_amount: c.allocatedAmount,
        allocated_hours: c.allocatedHours,
        sort_order: c.sortOrder,
      }));
      const { error: ccErr } = await supabase.from("po_cost_centers").insert(ccPayload);
      if (ccErr) throw ccErr;
    }

    // Small delay to avoid re-triggering Simpro's connection-dropping behavior
    // under sustained back-to-back requests (same mitigation as the
    // attachments sync script).
    await sleep(150);
  }

  const summary = {
    mode: report.mode,
    processed: report.processed,
    posCreated: report.posCreated.length,
    skippedAlreadyBackfilled: report.skippedAlreadyBackfilled.length,
    skippedNoCostCenters: report.skippedNoCostCenters.length,
    errors: report.errors.length,
  };
  console.table(summary);

  if (report.errors.length > 0) {
    console.log("\n⚠ Errors:");
    console.log(JSON.stringify(report.errors, null, 2));
  }

  const reportPath = path.join(
    __dirname,
    "data",
    `cost-center-backfill-report-${COMMIT ? "commit" : "dryrun"}-${Date.now()}.json`
  );
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nFull report written to ${reportPath}`);
  if (!COMMIT) {
    console.log("\nThis was a DRY RUN — nothing was written to Supabase. Re-run with --commit to apply.");
  }
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
