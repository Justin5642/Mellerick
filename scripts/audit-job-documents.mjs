#!/usr/bin/env node
/**
 * Job-document money audit — finds attachments a technician must not see.
 *
 * WHY THIS EXISTS: ~3.9k files were imported from Simpro into job_documents
 * (scripts/sync-simpro-attachments.mjs) with no review. Some are purchase
 * orders, supplier invoices, quotes or receipts — documents with dollar
 * figures. Migration 0065 added job_documents.office_only, which hides a
 * document (row AND file) from technicians. This script decides which
 * documents get that flag.
 *
 * HOW IT DECIDES, per document (first rule that applies wins):
 *   1. File name says money (PO, purchase order, invoice, quote, receipt,
 *      statement, pricing, remittance, "$" ...)            -> OFFICE
 *   2. Spreadsheet (xls/xlsx/csv/numbers)                   -> OFFICE
 *      (in a plumbing job these are almost always costings)
 *   3. CAD drawing (dwg/dxf/dwf/rvt/skp)                    -> VISIBLE
 *   4. PDF / image / text: the file is read by Claude Haiku, which answers
 *      whether it shows any prices or money amounts, or is a PO / invoice /
 *      quote / receipt                                     -> OFFICE or VISIBLE
 *   5. Anything else (Word docs, unknown types, files too big to read,
 *      read errors)                                         -> REVIEW
 *      REVIEW is treated as OFFICE on --commit unless --review=visible:
 *      hiding a harmless file from a tech is a much smaller mistake than
 *      showing them a price. The report lists every REVIEW file so office
 *      can un-hide them (Documents tab, "Office only" toggle).
 *
 * --commit only ever sets office_only = TRUE. It never clears the flag, so a
 * document someone hid by hand stays hidden on a re-run.
 *
 * REQUIRES (in .env.local): NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 * ANTHROPIC_API_KEY, and migration 0065 applied.
 *
 * USAGE:
 *   node --env-file=.env.local scripts/audit-job-documents.mjs [options]
 *
 * OPTIONS:
 *   --commit           Write office_only = true for OFFICE (and REVIEW) docs.
 *                      Without it nothing is written — dry run + report only.
 *   --simpro-only      Only documents imported from Simpro (simpro_file_id set).
 *   --limit=<n>        Only the first n documents (test batch).
 *   --review=visible   Leave REVIEW documents visible on --commit.
 *   --no-ai            Skip rule 4 (file-name/type rules only; PDFs -> REVIEW).
 *
 * OUTPUT: scripts/data/job-document-audit-<timestamp>.csv (gitignored — it
 * contains customer file names).
 *
 * COST: roughly US$1–5 for ~4k documents on Haiku (most are 1–3 page PDFs).
 */

import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- CLI args ----------
const args = process.argv.slice(2);
const COMMIT = args.includes("--commit");
const SIMPRO_ONLY = args.includes("--simpro-only");
const NO_AI = args.includes("--no-ai");
const REVIEW_VISIBLE = args.includes("--review=visible");
const LIMIT = Number(args.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? 0) || 0;

const MODEL = "claude-haiku-5-5";
const MAX_AI_BYTES = 20 * 1024 * 1024; // larger files go to REVIEW
const CONCURRENCY = 4;

// ---------- classification rules (exported for tests) ----------
export const MONEY_NAME =
  /(^|[^a-z])(p\.?o\.?|po\d+|purchase[\s_-]*order|invoice|inv\d+|tax[\s_-]*inv|quote|quotation|estimate|receipt|statement|remittance|pricing|price[\s_-]*list|costing|bill)([^a-z]|$)|\$/i;
const SPREADSHEET = new Set(["xls", "xlsx", "xlsm", "csv", "numbers", "ods"]);
const DRAWING = new Set(["dwg", "dxf", "dwf", "rvt", "skp"]);
const IMAGE_TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };

export function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name ?? "");
  return m ? m[1].toLowerCase() : "";
}

/** Rules 1–3 and the routing for rule 4/5. Returns { decision, reason } or { needs: "pdf"|"image"|"text" }. */
export function classifyByName(fileName, fileType) {
  const ext = extOf(fileName);
  // Strip the "simpro-<id>-" / "<ts>_" prefixes so the id digits can't look like "po123".
  const bare = (fileName ?? "").replace(/^simpro-\d+-/i, "").replace(/^\d+_/, "");
  if (MONEY_NAME.test(bare)) return { decision: "OFFICE", reason: "file name suggests a money document" };
  if (SPREADSHEET.has(ext)) return { decision: "OFFICE", reason: "spreadsheet (likely a costing)" };
  if (DRAWING.has(ext)) return { decision: "VISIBLE", reason: "CAD drawing" };
  if (ext === "pdf" || fileType === "application/pdf") return { needs: "pdf" };
  if (IMAGE_TYPES[ext]) return { needs: "image" };
  if (ext === "txt" || (fileType ?? "").startsWith("text/")) return { needs: "text" };
  return { decision: "REVIEW", reason: `can't read .${ext || "?"} files automatically` };
}

const PROMPT = `This file is attached to a plumbing company's job record. Technicians in the field can see job attachments, but must NOT see any pricing.

Does this document show ANY dollar amounts, prices, rates, costs, totals or other money figures — or is it a purchase order, invoice, quote, estimate, receipt or statement?

Answer with exactly one line: "MONEY: <short reason>" or "NO_MONEY: <short reason>".`;

/** Parse the model's one-line verdict. Anything unrecognised is REVIEW, never VISIBLE. */
export function parseVerdict(text) {
  const line = (text ?? "").trim().split("\n")[0];
  if (/^NO_MONEY\b/i.test(line)) return { decision: "VISIBLE", reason: `AI: ${line.replace(/^NO_MONEY:?\s*/i, "")}` };
  if (/^MONEY\b/i.test(line)) return { decision: "OFFICE", reason: `AI: ${line.replace(/^MONEY:?\s*/i, "")}` };
  return { decision: "REVIEW", reason: `AI gave no clear answer: ${line.slice(0, 80)}` };
}

// ---------- main ----------
async function main() {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", ...(NO_AI ? [] : ["ANTHROPIC_API_KEY"])]) {
    if (!process.env[k]) throw new Error(`${k} is not set (run with --env-file=.env.local)`);
  }
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const anthropic = NO_AI ? null : new Anthropic();

  const docs = await loadDocuments(supabase);
  console.log(`Job-document audit — ${COMMIT ? "COMMIT" : "dry run"} — ${docs.length} documents${SIMPRO_ONLY ? " (Simpro only)" : ""}`);

  const results = [];
  let next = 0;
  async function worker() {
    while (next < docs.length) {
      const doc = docs[next++];
      const verdict = await classify(doc, supabase, anthropic).catch((err) => ({
        decision: "REVIEW",
        reason: `error: ${err.message}`,
      }));
      results.push({ ...doc, ...verdict });
      if (results.length % 100 === 0) console.log(`  ${results.length}/${docs.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const hide = results.filter((r) => r.decision === "OFFICE" || (r.decision === "REVIEW" && !REVIEW_VISIBLE));
  const counts = results.reduce((acc, r) => ((acc[r.decision] = (acc[r.decision] ?? 0) + 1), acc), {});
  console.log(`\nOFFICE ${counts.OFFICE ?? 0} · VISIBLE ${counts.VISIBLE ?? 0} · REVIEW ${counts.REVIEW ?? 0}`);
  console.log(`${hide.length} documents ${COMMIT ? "will be" : "would be"} hidden from technicians.`);

  const reportPath = writeReport(results);
  console.log(`Report: ${reportPath}`);

  if (COMMIT) {
    const ids = hide.filter((r) => !r.office_only).map((r) => r.id);
    for (let i = 0; i < ids.length; i += 200) {
      const { error } = await supabase.from("job_documents").update({ office_only: true }).in("id", ids.slice(i, i + 200));
      if (error) throw new Error(`update failed at batch ${i / 200}: ${error.message}`);
    }
    console.log(`Marked ${ids.length} documents office-only.`);
  } else {
    console.log("Dry run — nothing written. Review the report, then re-run with --commit.");
  }
}

async function loadDocuments(supabase) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    let q = supabase
      .from("job_documents")
      .select("id, job_id, file_name, file_type, file_size, storage_path, office_only, simpro_file_id")
      .order("created_at")
      .range(from, from + 999);
    if (SIMPRO_ONLY) q = q.not("simpro_file_id", "is", null);
    const { data, error } = await q;
    if (error) throw new Error(`loading job_documents: ${error.message}`);
    out.push(...data);
    if (data.length < 1000 || (LIMIT && out.length >= LIMIT)) break;
  }
  return LIMIT ? out.slice(0, LIMIT) : out;
}

async function classify(doc, supabase, anthropic) {
  const byName = classifyByName(doc.file_name, doc.file_type);
  if (!byName.needs) return byName;
  if (!anthropic) return { decision: "REVIEW", reason: "AI check skipped (--no-ai)" };
  if (doc.file_size && doc.file_size > MAX_AI_BYTES) return { decision: "REVIEW", reason: "too large to read automatically" };

  const { data: blob, error } = await supabase.storage.from("job-documents").download(doc.storage_path);
  if (error) return { decision: "REVIEW", reason: `download failed: ${error.message}` };
  const bytes = Buffer.from(await blob.arrayBuffer());
  if (bytes.length > MAX_AI_BYTES) return { decision: "REVIEW", reason: "too large to read automatically" };

  let fileBlock;
  if (byName.needs === "pdf") {
    fileBlock = { type: "document", source: { type: "base64", media_type: "application/pdf", data: bytes.toString("base64") } };
  } else if (byName.needs === "image") {
    fileBlock = { type: "image", source: { type: "base64", media_type: IMAGE_TYPES[extOf(doc.file_name)], data: bytes.toString("base64") } };
  } else {
    fileBlock = { type: "text", text: `File contents:\n${bytes.toString("utf8").slice(0, 100_000)}` };
  }

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2000,
    output_config: { effort: "low" },
    messages: [{ role: "user", content: [fileBlock, { type: "text", text: PROMPT }] }],
  });
  if (response.stop_reason === "refusal") return { decision: "REVIEW", reason: "AI declined to read the file" };
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return parseVerdict(text);
}

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeReport(results) {
  const dir = path.join(__dirname, "data");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `job-document-audit-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`);
  const header = ["decision", "reason", "file_name", "job_id", "document_id", "already_office_only", "simpro_file_id", "storage_path"];
  const order = { OFFICE: 0, REVIEW: 1, VISIBLE: 2 };
  const rows = [...results]
    .sort((a, b) => order[a.decision] - order[b.decision] || String(a.file_name).localeCompare(String(b.file_name)))
    .map((r) => [r.decision, r.reason, r.file_name, r.job_id, r.id, r.office_only, r.simpro_file_id, r.storage_path].map(csvCell).join(","));
  fs.writeFileSync(file, [header.join(","), ...rows].join("\n") + "\n");
  return file;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err.message ?? err);
    process.exit(1);
  });
}
