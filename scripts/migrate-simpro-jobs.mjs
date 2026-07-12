#!/usr/bin/env node
/**
 * Simpro → Supabase job history migration loader.
 *
 * WHAT THIS SCRIPT DOES NOT DO: talk to Simpro directly. This repo has no
 * Simpro API credentials, and the Simpro access used to research this
 * migration only exists as an MCP tool inside a Claude session. So the
 * pipeline is two steps:
 *
 *   1. EXTRACT — a Claude session with the Simpro MCP tools fetches job/
 *      site/customer details and writes them to a JSON file matching the
 *      shape in `scripts/data/simpro-export.example.json`.
 *   2. LOAD (this script) — reads that JSON file and applies the matching
 *      rules below to decide what would be created/linked in Supabase,
 *      then (only with --commit) actually writes it.
 *
 * MATCHING RULES (from the two test-batch dry runs):
 *   - Company customers: match by exact, case-insensitive, trimmed name
 *     only. No fuzzy matching. If more than one existing row matches
 *     exactly (shouldn't happen, but be defensive) or the name is
 *     ambiguous, skip and flag for manual review rather than guess.
 *   - Individual customers: NEVER auto-matched against existing records,
 *     even on an apparent name match. Always created as new + flagged
 *     with needs_review = true, with any similar-looking existing
 *     customers listed in their notes for a human to check. This is
 *     because the existing customer table has no phone/email to
 *     disambiguate near-identical names (confirmed case: "John Bas" vs
 *     "John Bass" vs "John AfifBas" vs "Ken Basset").
 *   - Sites: keyed by Simpro site ID, not by job. The same Simpro site
 *     can appear on multiple jobs; it must only be created once.
 *   - Jobs: keyed by Simpro job ID. Re-running this script skips jobs
 *     already imported.
 *
 * USAGE:
 *   node --env-file=.env.local scripts/migrate-simpro-jobs.mjs [options]
 *
 * OPTIONS:
 *   --input=<path>   Path to the JSON export (default: scripts/data/simpro-export.json)
 *   --commit         Actually write to Supabase. Without this flag the
 *                     script only reads (SELECTs) and prints/saves a
 *                     dry-run report — nothing is inserted.
 *   --limit=<n>       Only process the first n jobs from the input file.
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the
 * environment (already in .env.local) — use `--env-file` so you don't
 * need a dotenv dependency.
 */

import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- CLI args ----------
const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const inputArg = args.find((a) => a.startsWith("--input="));
const INPUT_PATH = inputArg
  ? inputArg.split("=")[1]
  : path.join(__dirname, "data", "simpro-export.json");
const limitArg = args.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : Infinity;

// ---------- Supabase client ----------
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n" +
      "Run with: node --env-file=.env.local scripts/migrate-simpro-jobs.mjs"
  );
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

// ---------- Load input ----------
if (!fs.existsSync(INPUT_PATH)) {
  console.error(`Input file not found: ${INPUT_PATH}`);
  console.error(
    "See scripts/data/simpro-export.example.json for the expected shape."
  );
  process.exit(1);
}
const allJobs = JSON.parse(fs.readFileSync(INPUT_PATH, "utf8"));
const jobsToProcess = allJobs.slice(0, LIMIT);

// ---------- Report accumulator ----------
const report = {
  mode: COMMIT ? "COMMIT" : "DRY RUN",
  input: INPUT_PATH,
  totalJobsInFile: allJobs.length,
  processed: 0,
  jobs: {
    created: [],
    skippedAlreadyImported: [],
    skippedNoCustomer: [],
  },
  customers: {
    matchedExact: [],
    createdCompany: [],
    createdIndividualFlagged: [],
    skippedAmbiguous: [],
  },
  sites: {
    reused: [],
    created: [],
  },
};

// ---------- Helpers ----------
function mapJobType(simproType) {
  if (simproType === "Project") return "installation";
  if (simproType === "Service") return "service";
  return "service";
}

function buildCustomerDisplayName(c) {
  if (c.type === "Company") return (c.companyName ?? "").trim();
  return `${c.givenName ?? ""} ${c.familyName ?? ""}`.trim();
}

function buildJobTitle(job) {
  return (job.name && job.name.trim()) || (job.requestNo && job.requestNo.trim()) || `Simpro Job #${job.simproJobId}`;
}

function buildJobNotes(job) {
  const lines = [
    `Imported from Simpro job #${job.simproJobId} on ${new Date().toISOString().slice(0, 10)}.`,
  ];
  if (job.orderNo) lines.push(`Simpro order no: ${job.orderNo}`);
  if (job.statusName) lines.push(`Simpro status: ${job.statusName}`);
  if (job.notes) lines.push(`Simpro notes: ${job.notes}`);
  if (job.totalIncTax != null) lines.push(`Simpro total (inc tax): $${job.totalIncTax}`);
  return lines.join("\n");
}

/**
 * Resolve (or plan) a Supabase customer for a Simpro customer reference.
 * Returns { customerId, action, ...details } — customerId is null when
 * running in dry-run mode for a not-yet-created row, or when the job
 * should be skipped (ambiguous match).
 */
async function resolveCustomer(simproCustomer) {
  // Already linked from a previous run?
  const { data: linked, error: linkedErr } = await supabase
    .from("customers")
    .select("id, name")
    .eq("simpro_customer_id", simproCustomer.id)
    .maybeSingle();
  if (linkedErr) throw linkedErr;
  if (linked) {
    return { customerId: linked.id, action: "already-linked", name: linked.name };
  }

  const displayName = buildCustomerDisplayName(simproCustomer);

  if (simproCustomer.type === "Company") {
    // Exact, case-insensitive, trimmed match only. `ilike` with no
    // wildcards performs a case-insensitive equality check.
    const { data: matches, error } = await supabase
      .from("customers")
      .select("id, name")
      .ilike("name", displayName)
      .is("simpro_customer_id", null);
    if (error) throw error;

    if (matches.length === 1) {
      return { customerId: matches[0].id, action: "matched-exact", name: matches[0].name };
    }
    if (matches.length > 1) {
      return { customerId: null, action: "ambiguous-company-match", displayName, candidates: matches };
    }
    return { customerId: null, action: "create-company", displayName };
  }

  // Individual customers: never auto-matched. Look up similar names ONLY
  // to attach as a hint for the human reviewer — never to auto-link.
  const firstToken = displayName.split(" ")[0] || displayName;
  const { data: nearMatches, error: nmErr } = await supabase
    .from("customers")
    .select("id, name")
    .ilike("name", `%${firstToken}%`)
    .limit(10);
  if (nmErr) throw nmErr;

  return {
    customerId: null,
    action: "create-individual-flagged",
    displayName,
    nearMatches: nearMatches ?? [],
  };
}

async function resolveSite(simproSite, customerId) {
  const { data: existing, error } = await supabase
    .from("sites")
    .select("id, name")
    .eq("simpro_site_id", simproSite.id)
    .maybeSingle();
  if (error) throw error;
  if (existing) {
    return { siteId: existing.id, action: "reused", name: existing.name };
  }

  return {
    siteId: null,
    action: "create",
    payload: {
      customer_id: customerId,
      simpro_site_id: simproSite.id,
      name: simproSite.name || `Simpro Site #${simproSite.id}`,
      // Fall back to empty string (not a guess) when Simpro's own data is
      // blank — several legacy Simpro sites have no structured address,
      // only a free-text Name. See sites 1714-1718 (Garrong Ave batch).
      address_line1: (simproSite.addressLine1 || simproSite.name || "").trim(),
      suburb: (simproSite.suburb || "").trim(),
      state: (simproSite.state || "").trim(),
      postcode: (simproSite.postcode || "").trim(),
    },
  };
}

async function jobAlreadyImported(simproJobId) {
  const { data, error } = await supabase
    .from("jobs")
    .select("id")
    .eq("simpro_job_id", simproJobId)
    .maybeSingle();
  if (error) throw error;
  return !!data;
}

// ---------- Main ----------
async function main() {
  console.log(`\nSimpro → Supabase migration — ${report.mode}`);
  console.log(`Input: ${INPUT_PATH} (${jobsToProcess.length} of ${allJobs.length} jobs)\n`);

  for (const job of jobsToProcess) {
    report.processed++;

    if (await jobAlreadyImported(job.simproJobId)) {
      report.jobs.skippedAlreadyImported.push(job.simproJobId);
      continue;
    }

    const customerResolution = await resolveCustomer(job.customer);

    if (customerResolution.action === "ambiguous-company-match") {
      report.customers.skippedAmbiguous.push({
        simproCustomerId: job.customer.id,
        displayName: customerResolution.displayName,
        candidates: customerResolution.candidates,
        jobId: job.simproJobId,
      });
      report.jobs.skippedNoCustomer.push(job.simproJobId);
      continue;
    }

    let customerId = customerResolution.customerId;

    if (customerResolution.action === "matched-exact" || customerResolution.action === "already-linked") {
      report.customers.matchedExact.push({
        simproCustomerId: job.customer.id,
        matchedTo: customerResolution.name,
      });
      if (COMMIT && customerResolution.action === "matched-exact") {
        // Backfill the simpro_customer_id on the matched row so future
        // runs hit "already-linked" instead of re-matching by name.
        const { error } = await supabase
          .from("customers")
          .update({ simpro_customer_id: job.customer.id })
          .eq("id", customerId);
        if (error) throw error;
      }
    } else if (customerResolution.action === "create-company") {
      report.customers.createdCompany.push({
        simproCustomerId: job.customer.id,
        name: customerResolution.displayName,
      });
      if (COMMIT) {
        const { data, error } = await supabase
          .from("customers")
          .insert({
            name: customerResolution.displayName,
            company: customerResolution.displayName,
            simpro_customer_id: job.customer.id,
          })
          .select("id")
          .single();
        if (error) throw error;
        customerId = data.id;
      }
    } else if (customerResolution.action === "create-individual-flagged") {
      const nearNames = customerResolution.nearMatches.map((m) => m.name).join(", ");
      report.customers.createdIndividualFlagged.push({
        simproCustomerId: job.customer.id,
        name: customerResolution.displayName,
        possibleDuplicatesInSupabase: customerResolution.nearMatches,
      });
      if (COMMIT) {
        const { data, error } = await supabase
          .from("customers")
          .insert({
            name: customerResolution.displayName,
            simpro_customer_id: job.customer.id,
            needs_review: true,
            notes: nearNames
              ? `⚠ Imported from Simpro (individual). Possible existing duplicates — please check before treating as a new customer: ${nearNames}`
              : `⚠ Imported from Simpro (individual). No similar existing customer found, but please verify.`,
          })
          .select("id")
          .single();
        if (error) throw error;
        customerId = data.id;
      }
    }

    if (!COMMIT && customerId === null) {
      // In dry-run mode we never actually have a real customerId for
      // newly-"created" customers, so we can't test the site/job insert
      // chain further for those. That's fine — the report already shows
      // what would happen. Jobs against already-existing customers still
      // flow through fully below.
      report.jobs.skippedNoCustomer.push(job.simproJobId);
      continue;
    }

    const siteResolution = await resolveSite(job.site, customerId);
    let siteId = siteResolution.siteId;
    if (siteResolution.action === "reused") {
      report.sites.reused.push({ simproSiteId: job.site.id, name: siteResolution.name });
    } else {
      report.sites.created.push({ simproSiteId: job.site.id, ...siteResolution.payload });
      if (COMMIT) {
        const { data, error } = await supabase
          .from("sites")
          .insert(siteResolution.payload)
          .select("id")
          .single();
        if (error) throw error;
        siteId = data.id;
      }
    }

    const jobPayload = {
      simpro_job_id: job.simproJobId,
      customer_id: customerId,
      site_id: COMMIT ? siteId : null,
      title: buildJobTitle(job),
      description: job.description || null,
      notes: buildJobNotes(job),
      status: "completed",
      priority: "normal",
      job_type: mapJobType(job.type),
      actual_end: job.completedDate || null,
      created_at: job.dateIssued || undefined,
    };
    report.jobs.created.push(jobPayload);

    if (COMMIT) {
      const { error } = await supabase.from("jobs").insert(jobPayload);
      if (error) throw error;
    }
  }

  // ---------- Print + save report ----------
  const summary = {
    mode: report.mode,
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

  const reportPath = path.join(
    __dirname,
    "data",
    `migration-report-${COMMIT ? "commit" : "dryrun"}-${Date.now()}.json`
  );
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nFull report written to ${reportPath}`);
  if (!COMMIT) {
    console.log("\nThis was a DRY RUN — nothing was written to Supabase. Re-run with --commit to apply.");
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
