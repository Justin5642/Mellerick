#!/usr/bin/env node
/**
 * Backfill recent Simpro jobs that the original one-time migration missed.
 *
 * BACKGROUND: `migrate-simpro-jobs.mjs` loaded a static JSON snapshot that
 * only contained jobs Simpro had already marked Stage="Complete" at the
 * time it was captured (and even then, only some of them — 500 of 1,223
 * Complete jobs, going back to 2024-05-01). It never talked to Simpro's
 * live API. As a result, every job that is currently Pending, In Progress
 * (Simpro "Progress"), Invoiced-but-not-archived, or Archived was NEVER
 * migrated — regardless of how recent it is. Confirmed example: "747
 * Sayers Road, Hoppers Crossing" (Simpro site #2296, jobs #2661 "Progress"
 * and #2675 "Invoiced", issued 2026-03-31 and 2026-04-15) — both missing
 * entirely from `jobs`/`sites`/`customers`.
 *
 * Unlike `migrate-simpro-jobs.mjs`, this script talks to Simpro's live
 * REST API directly (same pattern as `sync-simpro-attachments.mjs`), so it
 * can be safely re-run at any time to pick up newly created/updated jobs.
 *
 * SCOPE: by default, backfills any Simpro job with DateIssued in the last
 * 12 months that does not already have a matching `jobs.simpro_job_id`
 * row in Supabase — regardless of Stage. Change --months to widen/narrow.
 *
 * MATCHING RULES (mirrors migrate-simpro-jobs.mjs exactly):
 *   - Company customers: exact, case-insensitive, trimmed name match only.
 *     Ambiguous (>1 match) => skip job, flag for manual review.
 *   - Individual customers: never auto-matched. Always created new with
 *     needs_review = true, near-name-matches listed in notes.
 *   - Sites: keyed by simpro_site_id. Reused across jobs at the same site.
 *   - Jobs: keyed by simpro_job_id. Re-running skips jobs already imported.
 *
 * STATUS MAPPING (Simpro Stage -> Supabase jobs.status), since we now know
 * the real stage instead of blindly forcing "completed":
 *   Pending -> pending | Progress -> in_progress
 *   Invoiced -> completed | Archived -> completed | Complete -> completed
 *
 * USAGE:
 *   node --env-file=.env.local scripts/backfill-recent-simpro-jobs.mjs [options]
 *
 * OPTIONS:
 *   --commit         Actually write to Supabase. Without this flag the
 *                     script only reads and prints/saves a dry-run report.
 *   --months=<n>      How many months back to consider "recent" (default 12).
 *   --limit=<n>       Only process the first n missing jobs found.
 *
 * Requires SIMPRO_BUILD_URL, SIMPRO_ACCESS_TOKEN, NEXT_PUBLIC_SUPABASE_URL,
 * SUPABASE_SERVICE_ROLE_KEY in the environment (.env.local).
 */

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- CLI args ----------
const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const monthsArg = args.find((a) => a.startsWith("--months="));
const MONTHS = monthsArg ? parseInt(monthsArg.split("=")[1], 10) : 12;
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : Infinity;

// ---------- Clients ----------
const SIMPRO_BUILD_URL = process.env.SIMPRO_BUILD_URL;
const SIMPRO_ACCESS_TOKEN = process.env.SIMPRO_ACCESS_TOKEN;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SIMPRO_BUILD_URL || !SIMPRO_ACCESS_TOKEN || !SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "Missing one of SIMPRO_BUILD_URL, SIMPRO_ACCESS_TOKEN, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.\n" +
      "Run with: node --env-file=.env.local scripts/backfill-recent-simpro-jobs.mjs"
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
const SIMPRO_COMPANY_ID = 0;

async function simproFetch(urlPath) {
  const res = await fetch(`${SIMPRO_BUILD_URL}${urlPath}`, {
    headers: { Authorization: `Bearer ${SIMPRO_ACCESS_TOKEN}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Simpro ${res.status} ${urlPath}: ${text}`);
  }
  return res;
}

async function simproFetchJson(urlPath) {
  return (await simproFetch(urlPath)).json();
}

async function fetchAllJobSummaries() {
  let page = 1;
  let totalPages = 1;
  const all = [];
  do {
    const res = await simproFetch(
      `/api/v1.0/companies/${SIMPRO_COMPANY_ID}/jobs/?page=${page}&pageSize=250&columns=ID,Stage,Status,DateIssued,Site,Customer,Type`
    );
    const pages = res.headers.get("result-pages");
    totalPages = pages ? parseInt(pages, 10) : 1;
    all.push(...(await res.json()));
    page++;
  } while (page <= totalPages);
  return all;
}

// ---------- Helpers (mirrors migrate-simpro-jobs.mjs) ----------
function mapJobType(simproType) {
  if (simproType === "Project") return "installation";
  if (simproType === "Service") return "service";
  return "service";
}

function mapStatus(stage) {
  switch (stage) {
    case "Pending":
      return "pending";
    case "Progress":
      return "in_progress";
    case "Invoiced":
    case "Archived":
    case "Complete":
      return "completed";
    default:
      return "pending";
  }
}

function buildCustomerDisplayName(simproCustomer) {
  if (simproCustomer.Type === "Company") return (simproCustomer.CompanyName ?? "").trim();
  return `${simproCustomer.GivenName ?? ""} ${simproCustomer.FamilyName ?? ""}`.trim();
}

function buildJobTitle(job) {
  return (job.Name && job.Name.trim()) || (job.RequestNo && job.RequestNo.trim()) || `Simpro Job #${job.ID}`;
}

function buildJobNotes(job) {
  const lines = [`Backfilled from Simpro job #${job.ID} on ${new Date().toISOString().slice(0, 10)}.`];
  if (job.OrderNo) lines.push(`Simpro order no: ${job.OrderNo}`);
  lines.push(`Simpro stage: ${job.Stage}`);
  if (job.Status?.Name) lines.push(`Simpro status: ${job.Status.Name}`);
  if (job.Notes) lines.push(`Simpro notes: ${job.Notes}`);
  if (job.Total?.IncTax != null) lines.push(`Simpro total (inc tax): $${job.Total.IncTax}`);
  return lines.join("\n");
}

async function resolveCustomer(simproCustomerRef) {
  const { data: linked, error: linkedErr } = await supabase
    .from("customers")
    .select("id, name")
    .eq("simpro_customer_id", simproCustomerRef.ID)
    .maybeSingle();
  if (linkedErr) throw linkedErr;
  if (linked) return { customerId: linked.id, action: "already-linked", name: linked.name };

  // Full detail fetch for phone/email — company vs individual endpoints differ.
  const detailPath =
    simproCustomerRef.Type === "Company"
      ? `/api/v1.0/companies/${SIMPRO_COMPANY_ID}/customers/companies/${simproCustomerRef.ID}`
      : `/api/v1.0/companies/${SIMPRO_COMPANY_ID}/customers/individuals/${simproCustomerRef.ID}`;
  const detail = await simproFetchJson(detailPath);

  const displayName = buildCustomerDisplayName(simproCustomerRef);

  if (simproCustomerRef.Type === "Company") {
    const { data: matches, error } = await supabase
      .from("customers")
      .select("id, name")
      .ilike("name", displayName)
      .is("simpro_customer_id", null);
    if (error) throw error;

    if (matches.length === 1) return { customerId: matches[0].id, action: "matched-exact", name: matches[0].name };
    if (matches.length > 1) return { customerId: null, action: "ambiguous-company-match", displayName, candidates: matches };
    return { customerId: null, action: "create-company", displayName, detail };
  }

  const firstToken = displayName.split(" ")[0] || displayName;
  const { data: nearMatches, error: nmErr } = await supabase
    .from("customers")
    .select("id, name")
    .ilike("name", `%${firstToken}%`)
    .limit(10);
  if (nmErr) throw nmErr;

  return { customerId: null, action: "create-individual-flagged", displayName, detail, nearMatches: nearMatches ?? [] };
}

async function resolveSite(simproSiteRef, customerId) {
  const { data: existing, error } = await supabase
    .from("sites")
    .select("id, name")
    .eq("simpro_site_id", simproSiteRef.ID)
    .maybeSingle();
  if (error) throw error;
  if (existing) return { siteId: existing.id, action: "reused", name: existing.name };

  const detail = await simproFetchJson(`/api/v1.0/companies/${SIMPRO_COMPANY_ID}/sites/${simproSiteRef.ID}`);
  const addr = detail.Address || {};

  return {
    siteId: null,
    action: "create",
    payload: {
      customer_id: customerId,
      simpro_site_id: simproSiteRef.ID,
      name: detail.Name || simproSiteRef.Name || `Simpro Site #${simproSiteRef.ID}`,
      address_line1: (addr.Address || detail.Name || simproSiteRef.Name || "").trim(),
      suburb: (addr.City || "").trim(),
      state: (addr.State || "").trim(),
      postcode: (addr.PostalCode || "").trim(),
    },
  };
}

async function jobAlreadyImported(simproJobId) {
  const { data, error } = await supabase.from("jobs").select("id").eq("simpro_job_id", simproJobId).maybeSingle();
  if (error) throw error;
  return !!data;
}

// ---------- Report ----------
const report = {
  mode: COMMIT ? "COMMIT" : "DRY RUN",
  monthsBack: MONTHS,
  totalSimproJobsScanned: 0,
  candidateJobs: 0,
  processed: 0,
  jobs: { created: [], skippedAlreadyImported: [], skippedNoCustomer: [] },
  customers: { matchedExact: [], createdCompany: [], createdIndividualFlagged: [], skippedAmbiguous: [] },
  sites: { reused: [], created: [] },
};

async function main() {
  console.log(`\nSimpro recent-jobs backfill — ${report.mode} (last ${MONTHS} months)\n`);

  console.log("Fetching all Simpro jobs (paginated)...");
  const allSummaries = await fetchAllJobSummaries();
  report.totalSimproJobsScanned = allSummaries.length;
  console.log(`  -> ${allSummaries.length} total jobs in Simpro`);

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - MONTHS);

  const candidates = [];
  for (const j of allSummaries) {
    if (!j.DateIssued || new Date(j.DateIssued) < cutoff) continue;
    if (await jobAlreadyImported(j.ID)) {
      report.jobs.skippedAlreadyImported.push(j.ID);
      continue;
    }
    candidates.push(j);
  }
  report.candidateJobs = candidates.length;
  console.log(`  -> ${candidates.length} candidate jobs issued since ${cutoff.toISOString().slice(0, 10)} and not yet in Supabase\n`);

  const toProcess = candidates.slice(0, LIMIT);

  for (const summary of toProcess) {
    report.processed++;
    const job = await simproFetchJson(`/api/v1.0/companies/${SIMPRO_COMPANY_ID}/jobs/${summary.ID}`);

    const customerResolution = await resolveCustomer(job.Customer);

    if (customerResolution.action === "ambiguous-company-match") {
      report.customers.skippedAmbiguous.push({
        simproCustomerId: job.Customer.ID,
        displayName: customerResolution.displayName,
        candidates: customerResolution.candidates,
        jobId: job.ID,
      });
      report.jobs.skippedNoCustomer.push(job.ID);
      continue;
    }

    let customerId = customerResolution.customerId;

    if (customerResolution.action === "matched-exact" || customerResolution.action === "already-linked") {
      report.customers.matchedExact.push({ simproCustomerId: job.Customer.ID, matchedTo: customerResolution.name });
      if (COMMIT && customerResolution.action === "matched-exact") {
        const { error } = await supabase.from("customers").update({ simpro_customer_id: job.Customer.ID }).eq("id", customerId);
        if (error) throw error;
      }
    } else if (customerResolution.action === "create-company") {
      const d = customerResolution.detail;
      report.customers.createdCompany.push({ simproCustomerId: job.Customer.ID, name: customerResolution.displayName });
      if (COMMIT) {
        const { data, error } = await supabase
          .from("customers")
          .insert({
            name: customerResolution.displayName,
            company: customerResolution.displayName,
            email: d?.Email || null,
            phone: d?.Phone || null,
            simpro_customer_id: job.Customer.ID,
          })
          .select("id")
          .single();
        if (error) throw error;
        customerId = data.id;
      }
    } else if (customerResolution.action === "create-individual-flagged") {
      const d = customerResolution.detail;
      const nearNames = customerResolution.nearMatches.map((m) => m.name).join(", ");
      report.customers.createdIndividualFlagged.push({
        simproCustomerId: job.Customer.ID,
        name: customerResolution.displayName,
        possibleDuplicatesInSupabase: customerResolution.nearMatches,
      });
      if (COMMIT) {
        const { data, error } = await supabase
          .from("customers")
          .insert({
            name: customerResolution.displayName,
            email: d?.Email || null,
            phone: d?.Phone || null,
            simpro_customer_id: job.Customer.ID,
            needs_review: true,
            notes: nearNames
              ? `⚠ Backfilled from Simpro (individual). Possible existing duplicates — please check before treating as a new customer: ${nearNames}`
              : `⚠ Backfilled from Simpro (individual). No similar existing customer found, but please verify.`,
          })
          .select("id")
          .single();
        if (error) throw error;
        customerId = data.id;
      }
    }

    if (!COMMIT && customerId === null) {
      report.jobs.skippedNoCustomer.push(job.ID);
      continue;
    }

    const siteResolution = await resolveSite(job.Site, customerId);
    let siteId = siteResolution.siteId;
    if (siteResolution.action === "reused") {
      report.sites.reused.push({ simproSiteId: job.Site.ID, name: siteResolution.name });
    } else {
      report.sites.created.push({ simproSiteId: job.Site.ID, ...siteResolution.payload });
      if (COMMIT) {
        const { data, error } = await supabase.from("sites").insert(siteResolution.payload).select("id").single();
        if (error) throw error;
        siteId = data.id;
      }
    }

    const jobPayload = {
      simpro_job_id: job.ID,
      customer_id: customerId,
      site_id: COMMIT ? siteId : null,
      title: buildJobTitle(job),
      description: job.Description || null,
      notes: buildJobNotes(job),
      status: mapStatus(job.Stage),
      // These are historical Simpro jobs, already completed and invoiced in
      // Simpro long before this app existed — they must not land in the
      // Approvals "pending" queue and drown out jobs that actually need an
      // admin's attention (see 2026-07 cleanup after 668 imported jobs did
      // exactly that).
      admin_status: "approved",
      priority: "normal",
      job_type: mapJobType(job.Type),
      actual_end: job.CompletedDate || null,
      created_at: job.DateIssued || undefined,
    };
    report.jobs.created.push(jobPayload);

    if (COMMIT) {
      const { error } = await supabase.from("jobs").insert(jobPayload);
      if (error) throw error;
    }
  }

  const summary = {
    mode: report.mode,
    totalSimproJobsScanned: report.totalSimproJobsScanned,
    candidateJobs: report.candidateJobs,
    processed: report.processed,
    jobsCreated: report.jobs.created.length,
    jobsSkippedAlreadyImported: report.jobs.skippedAlreadyImported.length,
    jobsSkippedNoCustomer: report.jobs.skippedNoCustomer.length,
    customersMatchedExact: report.customers.matchedExact.length,
    customersCreatedCompany: report.customers.createdCompany.length,
    customersCreatedIndividualFlagged: report.customers.createdIndividualFlagged.length,
    customersSkippedAmbiguous: report.customers.skippedAmbiguous.length,
    sitesReused: report.sites.reused.length,
    sitesCreated: report.sites.created.length,
  };
  console.table(summary);

  if (report.customers.skippedAmbiguous.length > 0) {
    console.log("\n⚠ Ambiguous company matches — skipped, needs manual review:");
    console.log(JSON.stringify(report.customers.skippedAmbiguous, null, 2));
  }
  if (report.customers.createdIndividualFlagged.length > 0) {
    console.log("\n⚠ Individuals created with needs_review = true:");
    for (const c of report.customers.createdIndividualFlagged) {
      console.log(`  - "${c.name}" (Simpro #${c.simproCustomerId})`);
      if (c.possibleDuplicatesInSupabase.length) {
        console.log(`      possible duplicates: ${c.possibleDuplicatesInSupabase.map((m) => m.name).join(", ")}`);
      }
    }
  }

  const reportPath = path.join(__dirname, "data", `backfill-report-${COMMIT ? "commit" : "dryrun"}-${Date.now()}.json`);
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
