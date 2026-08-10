#!/usr/bin/env node
// What do the office/admin sync streams actually replicate to a device?
//
// The 18 office_* streams in mobile/powersync/sync-streams.yaml are written as
// `SELECT <table>.*`, so the answer is "every column the table has, now and
// after any future migration". Nothing in the repo records what that set IS —
// supabase/schema.sql covers 15 tables and 8 of the streamed ones are not among
// them — so the blast radius of that `*` has never been written down.
//
// This prints it, from the live database via PostgREST's OpenAPI description,
// which is the same column set PowerSync would see.
//
//   node scripts/check-sync-stream-columns.mjs
//   node scripts/check-sync-stream-columns.mjs --json    # machine-readable
//
// Read-only: one GET. Writes nothing, and prints no row data — column NAMES and
// types only, never values.

import { readFileSync } from "node:fs";

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

// The tables the office_* streams replicate wholesale, in file order.
const OFFICE_TABLES = [
  "jobs",
  "job_items",
  "job_variations",
  "job_expenses",
  "job_notes",
  "invoices",
  "invoice_items",
  "quotes",
  "quote_items",
  "pricing_items",
  "inventory",
  "equipment",
  "equipment_expenses",
  "equipment_usage_log",
  "purchase_orders",
  "po_cost_centers",
];

const res = await fetch(`${url}/rest/v1/`, {
  headers: { apikey: key, Authorization: `Bearer ${key}` },
});
if (!res.ok) {
  console.error(`OpenAPI fetch failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const spec = await res.json();
const defs = spec.definitions ?? spec.components?.schemas ?? {};

// Anything matching these is worth a human deciding before it reaches a phone.
// Deliberately WIDER than the money classifier in
// tests/unit/sync-streams-contract.test.ts: office users are allowed to see
// money, so money is not the risk here. The risk is a column that should not
// leave the server for ANYONE — a credential, a token, a third party's bank
// details — landing in plaintext SQLite on every office device because a
// migration added it and no review step exists.
const SENSITIVE = /(token|secret|password|passwd|api_key|apikey|credential|private|bank|bsb|account_number|iban|swift|tax_file|tfn|ssn|licence_no|license_no)/i;

const report = {};
let sensitiveHits = 0;

for (const table of OFFICE_TABLES) {
  const def = defs[table];
  if (!def?.properties) {
    report[table] = { error: "not present in the PostgREST schema" };
    continue;
  }
  const columns = Object.keys(def.properties).sort();
  const flagged = columns.filter((c) => SENSITIVE.test(c));
  sensitiveHits += flagged.length;
  report[table] = { count: columns.length, columns, flagged };
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  let total = 0;
  for (const [table, r] of Object.entries(report)) {
    if (r.error) {
      console.log(`${table.padEnd(24)} !! ${r.error}`);
      continue;
    }
    total += r.count;
    console.log(`${table.padEnd(24)} ${String(r.count).padStart(3)} columns`);
    if (r.flagged.length) console.log(`${" ".repeat(24)}  FLAGGED: ${r.flagged.join(", ")}`);
  }
  console.log(`\n${total} columns reach every office/admin device today.`);
  console.log(
    sensitiveHits === 0
      ? "No column name matches the sensitive pattern — the exposure today is business data only."
      : `${sensitiveHits} column name(s) matched the sensitive pattern — review before shipping.`
  );
}
