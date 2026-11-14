// The customer job report sent with an invoice (Send Invoice dialog → "Include
// job report and photos"). Pure data shaping only — loading lives in
// lib/job-report-data.ts, the PDF in lib/pdf/job-report-template.tsx.
//
// What a customer may see, decided with Justin (Nov 2026):
//   * the days we attended and who came — NO hours anywhere (fixed-price
//     builders must not see hours) and no rates or money of any kind;
//   * notes on the work done: stage notes, the voice report and the
//     completion notes as a default the office edits before sending. General
//     job_notes are NOT used — they can be internal;
//   * the job's ordinary photos, minus signatures (their own section) and
//     delivery dockets (vendor_order_id set — a docket can show prices);
//   * the customer's sign-off, if one was captured.

import { anchorForDateKey, dateKeyInBusinessTZ, formatDate } from "@/lib/date";
import { getJobStageLabel } from "@/lib/job-stages";

/** Longest notes text accepted from the dialog. */
export const MAX_REPORT_NOTES_CHARS = 20_000;
/** At most this many photos go into one report. */
export const MAX_REPORT_PHOTOS = 40;
/** Budget for the embedded (already downscaled) images, leaving room under ~15 MB for the PDF. */
export const MAX_REPORT_IMAGE_BYTES = 14 * 1024 * 1024;

export interface ReportTimeEntry {
  staff_id: string | null;
  clock_in: string | null;
  entry_type?: string | null;
}

export interface ReportVisit {
  /** "YYYY-MM-DD" in Melbourne. */
  dateKey: string;
  /** "Mon 3 Nov 2026". */
  label: string;
  /** Distinct technician names that day, A–Z. */
  names: string[];
}

const visitDateOpts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", year: "numeric" };

/**
 * The days attended, oldest first, from the job's WORK time entries (travel
 * is not attendance), each with the distinct technicians on site. Only the
 * day and the names — never a time or a duration.
 */
export function groupVisitsByDay(entries: ReportTimeEntry[], namesById: Record<string, string>): ReportVisit[] {
  const byDay = new Map<string, Set<string>>();
  for (const e of entries) {
    if (!e.clock_in) continue;
    if ((e.entry_type ?? "work") !== "work") continue;
    const key = dateKeyInBusinessTZ(e.clock_in);
    if (key === "Invalid Date") continue;
    const names = byDay.get(key) ?? new Set<string>();
    const name = e.staff_id ? namesById[e.staff_id]?.trim() : "";
    if (name) names.add(name);
    byDay.set(key, names);
  }
  return [...byDay.keys()]
    .sort()
    .map((dateKey) => ({
      dateKey,
      label: formatDate(anchorForDateKey(dateKey), visitDateOpts),
      names: [...(byDay.get(dateKey) ?? [])].sort((a, b) => a.localeCompare(b)),
    }));
}

export interface ReportStageNote {
  stage: string;
  content: string | null;
  created_at: string;
}

/**
 * The default "work done" text the office edits in the dialog: stage notes in
 * the order they were written ("Drain — 3 Nov 2026"), then the voice report,
 * then the completion notes. Blank parts are left out; "" when there is
 * nothing at all.
 */
export function composeDefaultNotes(input: {
  stageNotes: ReportStageNote[];
  voiceReportTranscript?: string | null;
  completionNotes?: string | null;
}): string {
  const parts: string[] = [];
  const notes = [...input.stageNotes]
    .filter((n) => n.content && n.content.trim())
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const n of notes) {
    const when = formatDate(n.created_at, { day: "numeric", month: "short", year: "numeric" });
    parts.push(`${getJobStageLabel(n.stage)} — ${when}\n${n.content!.trim()}`);
  }
  const voice = input.voiceReportTranscript?.trim();
  if (voice) parts.push(`Job report\n${voice}`);
  const completion = input.completionNotes?.trim();
  // The voice report is sometimes copied into the completion notes; don't say it twice.
  if (completion && completion !== voice) parts.push(`Completion notes\n${completion}`);
  return parts.join("\n\n");
}

export interface ReportPhotoRow {
  id: string;
  storage_path: string | null;
  caption: string | null;
  photo_type: string | null;
  vendor_order_id?: string | null;
  created_at: string;
}

/** Extensions the server can decode and re-encode as JPEG for the PDF. */
const RENDERABLE_EXT = new Set(["jpg", "jpeg", "jfif", "png", "webp"]);

export function photoExtension(path: string): string {
  const file = path.split("/").pop() ?? "";
  const dot = file.lastIndexOf(".");
  return dot > 0 ? file.slice(dot + 1).toLowerCase() : "";
}

export type PhotoExclusion = "signature" | "docket" | "format" | "missing";

/** Why a photo can't go in the report, or null when it can. */
export function photoExclusion(p: ReportPhotoRow): PhotoExclusion | null {
  if (p.photo_type === "signature") return "signature";
  if (p.vendor_order_id) return "docket";
  if (!p.storage_path) return "missing";
  if (!RENDERABLE_EXT.has(photoExtension(p.storage_path))) return "format";
  return null;
}

/** The photos a report may include, oldest first. */
export function eligiblePhotos<T extends ReportPhotoRow>(photos: T[]): T[] {
  return photos
    .filter((p) => photoExclusion(p) === null)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

/** Photos left out only because of their file type (HEIC etc.) — the dialog says how many. */
export function unsupportedPhotoCount(photos: ReportPhotoRow[]): number {
  return photos.filter((p) => photoExclusion(p) === "format").length;
}

/** The customer sign-off: the latest signature row. Its caption is the signer's name. */
export function latestSignature<T extends ReportPhotoRow>(photos: T[]): T | null {
  const sigs = photos.filter((p) => p.photo_type === "signature" && p.storage_path);
  if (sigs.length === 0) return null;
  return sigs.reduce((a, b) => (b.created_at > a.created_at ? b : a));
}

export interface JobReportRequest {
  notes: string;
  photoIds: string[];
  includeSignature: boolean;
}

export type ParsedReportRequest = { ok: true; value: JobReportRequest } | { ok: false; error: string };

/**
 * Validate the dialog's `jobReport` body. Shape only — which photo ids are
 * allowed is decided against the database (selectRequestedPhotos).
 */
export function parseJobReportRequest(raw: unknown): ParsedReportRequest {
  if (!raw || typeof raw !== "object") return { ok: false, error: "The job report details are missing." };
  const r = raw as Record<string, unknown>;
  const notes = typeof r.notes === "string" ? r.notes.replace(/\r\n/g, "\n") : "";
  if (r.notes != null && typeof r.notes !== "string") return { ok: false, error: "The job report notes are not valid." };
  if (notes.length > MAX_REPORT_NOTES_CHARS) {
    return { ok: false, error: `The job report notes are too long (at most ${MAX_REPORT_NOTES_CHARS.toLocaleString("en-AU")} characters).` };
  }
  if (r.photoIds != null && !Array.isArray(r.photoIds)) return { ok: false, error: "The job report photo list is not valid." };
  const photoIds = [...new Set(((r.photoIds as unknown[] | undefined) ?? []).filter((x): x is string => typeof x === "string"))];
  return { ok: true, value: { notes, photoIds, includeSignature: r.includeSignature === true } };
}

/**
 * The photos to include: the requested ids that are eligible photos of THIS
 * job, in report order. Anything else the client sent is ignored.
 */
export function selectRequestedPhotos<T extends ReportPhotoRow>(jobPhotos: T[], photoIds: string[]): T[] {
  const wanted = new Set(photoIds);
  return eligiblePhotos(jobPhotos).filter((p) => wanted.has(p.id));
}

export interface PhotoBudgetResult {
  /** Indexes (into the input) that fit, in order. */
  kept: number[];
  /** How many were left out for the count or size cap. */
  omitted: number;
}

/**
 * Keep photos in order until the count cap or the byte budget is reached.
 * `sizes` are the downscaled byte sizes; a null size (failed to load) is
 * skipped and not counted against either cap. Stops at the first photo that
 * would overflow, so the report is "the first N" rather than a scattering.
 */
export function applyPhotoBudget(
  sizes: (number | null)[],
  maxCount = MAX_REPORT_PHOTOS,
  maxBytes = MAX_REPORT_IMAGE_BYTES,
): PhotoBudgetResult {
  const kept: number[] = [];
  let bytes = 0;
  let stoppedAt = sizes.length;
  for (let i = 0; i < sizes.length; i++) {
    const size = sizes[i];
    if (size == null) continue;
    if (kept.length >= maxCount || bytes + size > maxBytes) {
      stoppedAt = i;
      break;
    }
    kept.push(i);
    bytes += size;
  }
  const omitted = sizes.slice(stoppedAt).filter((s) => s != null).length;
  return { kept, omitted };
}

/** The office-facing sentence about what was left out, or null when everything went in. */
export function reportNotice(counts: { omittedForSize: number; failed: number; included: number }): string | null {
  const bits: string[] = [];
  if (counts.omittedForSize > 0) {
    bits.push(
      `The report holds the first ${counts.included} photo${counts.included === 1 ? "" : "s"}; ` +
        `${counts.omittedForSize} more did not fit (at most ${MAX_REPORT_PHOTOS} photos or about 15 MB).`,
    );
  }
  if (counts.failed > 0) {
    bits.push(`${counts.failed} photo${counts.failed === 1 ? "" : "s"} could not be read and ${counts.failed === 1 ? "was" : "were"} left out.`);
  }
  return bits.length ? bits.join(" ") : null;
}

/** Caption line under a photo in the PDF: "Caption · 3 Nov 2026". */
export function photoCaptionLine(p: { caption: string | null; created_at: string }): string {
  const when = formatDate(p.created_at, { day: "numeric", month: "short", year: "numeric" });
  const caption = p.caption?.trim();
  return caption ? `${caption} · ${when}` : when;
}

/** Split into rows of `n` for the two-per-row photo grid. */
export function chunk<T>(items: T[], n: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += n) rows.push(items.slice(i, i + n));
  return rows;
}
