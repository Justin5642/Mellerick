#!/usr/bin/env node
// READ-ONLY probe. Answers the one question that decides whether scoping DELETE
// on job-photos / job-audio by job id is safe: does every object key actually
// start with a real job id?
//
// The proposed policy extracts the job with split_part(name, '/', 1). Any object
// whose first segment is not a jobs.id row becomes deletable by office/admin
// only -- permanently orphaned from the technician's point of view. That number
// needs to be measured, not assumed.
//
// Deletes nothing. Writes nothing. Only counts.

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

// The scripts in this repo read a plain .env; do the same rather than requiring
// the caller to have exported anything.
for (const file of [".env.local", ".env"]) {
  try {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const BUCKETS = ["job-photos", "job-audio"];

// storage.objects over PostgREST with the storage schema profile. One request
// per page beats walking the storage API's per-prefix list(), which would need
// one round trip per job folder.
async function objectsViaRest(bucket) {
  const rows = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const res = await fetch(
      `${url}/rest/v1/objects?select=name,bucket_id&bucket_id=eq.${bucket}&limit=${PAGE}&offset=${offset}`,
      {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Accept-Profile": "storage",
        },
      }
    );
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows.map((r) => r.name);
}

// Fallback: walk the storage API one prefix at a time.
async function objectsViaStorageApi(supabase, bucket) {
  const names = [];
  const { data: top, error } = await supabase.storage.from(bucket).list("", { limit: 10000 });
  if (error) throw error;
  for (const entry of top ?? []) {
    if (entry.id === null) {
      // A folder. Recurse one level, then one more for job-photos/<job>/variations.
      const { data: inner } = await supabase.storage.from(bucket).list(entry.name, { limit: 10000 });
      for (const f of inner ?? []) {
        if (f.id === null) {
          const { data: deep } = await supabase.storage
            .from(bucket)
            .list(`${entry.name}/${f.name}`, { limit: 10000 });
          for (const d of deep ?? []) names.push(`${entry.name}/${f.name}/${d.name}`);
        } else {
          names.push(`${entry.name}/${f.name}`);
        }
      }
    } else {
      names.push(entry.name);
    }
  }
  return names;
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

// Every job id, plus whether it has an assignee. A job with assigned_to NULL has
// no technician who can delete its objects under the proposed policy.
const jobs = new Map();
{
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from("jobs")
      .select("id, assigned_to, status")
      .range(offset, offset + PAGE - 1);
    if (error) throw error;
    for (const j of data) jobs.set(String(j.id), j);
    if (data.length < PAGE) break;
  }
}
console.log(`jobs in database: ${jobs.size}`);
console.log(`  with assigned_to set:  ${[...jobs.values()].filter((j) => j.assigned_to).length}`);
console.log(`  with assigned_to NULL: ${[...jobs.values()].filter((j) => !j.assigned_to).length}`);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

for (const bucket of BUCKETS) {
  console.log(`\n=== ${bucket} ===`);
  let names;
  try {
    names = await objectsViaRest(bucket);
    console.log(`  (read via storage.objects over PostgREST)`);
  } catch (e) {
    console.log(`  PostgREST route unavailable (${String(e.message).slice(0, 80)}); walking storage API`);
    names = await objectsViaStorageApi(supabase, bucket);
  }

  console.log(`  objects: ${names.length}`);
  if (names.length === 0) continue;

  const seg = (n) => n.split("/")[0];
  const buckets = {
    matchesJob: [],
    uuidButNoJob: [],
    notUuid: [],
    emptyFirstSegment: [],
    noSlash: [],
  };
  for (const n of names) {
    if (!n.includes("/")) buckets.noSlash.push(n);
    else if (seg(n) === "") buckets.emptyFirstSegment.push(n);
    else if (jobs.has(seg(n))) buckets.matchesJob.push(n);
    else if (UUID.test(seg(n))) buckets.uuidButNoJob.push(n);
    else buckets.notUuid.push(n);
  }

  const pct = (a) => `${((a.length / names.length) * 100).toFixed(1)}%`;
  console.log(`  first segment IS a live job id : ${buckets.matchesJob.length} (${pct(buckets.matchesJob)})`);
  console.log(`  uuid-shaped but NO job row     : ${buckets.uuidButNoJob.length}  <- orphans`);
  console.log(`  first segment not a uuid       : ${buckets.notUuid.length}  <- policy cannot match`);
  console.log(`  empty first segment (leading /): ${buckets.emptyFirstSegment.length}`);
  console.log(`  no '/' at all (bucket root)    : ${buckets.noSlash.length}  <- policy cannot match`);

  for (const [label, list] of Object.entries(buckets)) {
    if (list.length && label !== "matchesJob") {
      console.log(`    ${label} samples: ${list.slice(0, 5).map((s) => JSON.stringify(s)).join(", ")}`);
    }
  }

  // Of the objects that DO map to a job, how many belong to a job with no
  // assignee? Under the proposed policy no technician can ever delete those.
  const unassigned = buckets.matchesJob.filter((n) => !jobs.get(seg(n))?.assigned_to);
  console.log(`  belong to a job with assigned_to NULL: ${unassigned.length}  <- office/admin-only forever`);

  // Path-shape census, so the policy author can see every convention in use.
  const shapes = new Map();
  for (const n of names) {
    const parts = n.split("/");
    const rest = parts.slice(1).join("/");
    let shape;
    if (parts.length === 1) shape = "<root object>";
    else if (parts.length > 2) shape = `<jobId>/${parts[1]}/...`;
    else if (/^signature_/.test(rest)) shape = "<jobId>/signature_*";
    else if (/^voice-report/.test(rest)) shape = "<jobId>/voice-report*";
    else if (/^expense-receipt-/.test(rest)) shape = "<jobId>/expense-receipt-*";
    else if (/^\d{13}_/.test(rest)) shape = "<jobId>/<epochMs>_<name>   (web upload)";
    else if (UUID.test(rest.replace(/\.[^.]+$/, ""))) shape = "<jobId>/<rowUuid>.<ext>  (mobile upload)";
    else shape = `<jobId>/<other: ${rest.slice(0, 24)}>`;
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
  }
  console.log(`  path shapes:`);
  for (const [s, c] of [...shapes.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(c).padStart(6)}  ${s}`);
  }
}
