import type { SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";
import { INVOICE_SITE_SELECT, invoiceJobSite, type JobSite } from "@/lib/job-site";
import { fetchAllRows } from "@/lib/fetch-all-rows";
import { thumbPathFor } from "@/lib/photo-thumbs";
import { businessInfo } from "@/lib/business-info";
import {
  applyPhotoBudget,
  composeDefaultNotes,
  eligiblePhotos,
  groupVisitsByDay,
  latestSignature,
  MAX_REPORT_PHOTOS,
  reportNotice,
  selectRequestedPhotos,
  unsupportedPhotoCount,
  type JobReportRequest,
  type ReportPhotoRow,
  type ReportVisit,
} from "@/lib/job-report";
import { renderJobReportPdf } from "@/lib/pdf/render-job-report";
import type { JobReportPhoto } from "@/lib/pdf/job-report-template";

// Server side of the customer job report (lib/job-report.ts has the rules).
// Every read runs through the CALLER's client — the routes only reach here
// after requireOfficeOrAdmin, and RLS stays the boundary. Nothing selected here
// carries money: time entries are read for the day and the person only
// (never hours, never rate_override), and docket photos are filtered out.

const PHOTO_COLS = "id, storage_path, caption, photo_type, vendor_order_id, created_at";
const SIGNED_URL_TTL_S = 3600;
/** Photos downloaded and downscaled at once. */
const PHOTO_CONCURRENCY = 4;
/** Longest edge of a photo in the PDF (two per row on A4 needs far less). */
const PHOTO_MAX_EDGE = 1200;
const PHOTO_JPEG_QUALITY = 70;

export interface JobReportContext {
  invoice: { id: string; invoice_number: number | string; title: string | null; customerName: string };
  job: { id: string; job_number: number | null; title: string | null };
  site: JobSite | null;
  visits: ReportVisit[];
  defaultNotes: string;
  /** Every job_photos row of the job (eligibility is decided from these). */
  photos: ReportPhotoRow[];
}

export type LoadResult =
  | { ok: true; context: JobReportContext }
  | { ok: false; status: 400 | 404 | 500; error: string };

/** Load everything a report for this invoice can draw on. */
export async function loadJobReportContext(supabase: SupabaseClient, invoiceId: string): Promise<LoadResult> {
  const { data: invoice, error: invoiceError } = await supabase
    .from("invoices")
    .select(`id, invoice_number, title, job_id, customers(name), ${INVOICE_SITE_SELECT}`)
    .eq("id", invoiceId)
    .maybeSingle();
  if (invoiceError) {
    console.error("job report: invoice read failed:", invoiceError.message);
    return { ok: false, status: 500, error: "Could not load the invoice." };
  }
  if (!invoice) return { ok: false, status: 404, error: "Invoice not found." };
  if (!invoice.job_id) return { ok: false, status: 400, error: "This invoice is not linked to a job, so there is no job report." };

  const jobId = invoice.job_id as string;
  const [jobRes, entriesRes, stageRes, photosRes] = await Promise.all([
    supabase.from("jobs").select("id, job_number, title, completion_notes, voice_report_transcript").eq("id", jobId).maybeSingle(),
    fetchAllRows<{ staff_id: string | null; clock_in: string | null; entry_type: string | null }>((c) =>
      supabase.from("time_entries").select("id, staff_id, clock_in, entry_type", c).eq("job_id", jobId).order("id"),
    ),
    fetchAllRows<{ stage: string; content: string | null; created_at: string }>((c) =>
      supabase.from("job_stage_notes").select("id, stage, content, created_at", c).eq("job_id", jobId).order("id"),
    ),
    fetchAllRows<ReportPhotoRow>((c) => supabase.from("job_photos").select(PHOTO_COLS, c).eq("job_id", jobId).order("id")),
  ]);
  if (jobRes.error || !jobRes.data) {
    if (jobRes.error) console.error("job report: job read failed:", jobRes.error.message);
    return { ok: false, status: jobRes.error ? 500 : 404, error: jobRes.error ? "Could not load the job." : "The invoice's job was not found." };
  }
  for (const [what, res] of [["time entries", entriesRes], ["stage notes", stageRes], ["photos", photosRes]] as const) {
    if (!res.ok) {
      console.error(`job report: ${what} read failed:`, res.error);
      return { ok: false, status: 500, error: "Could not load the job's details." };
    }
  }
  const entries = entriesRes.ok ? entriesRes.rows : [];
  const staffIds = [...new Set(entries.map((e) => e.staff_id).filter((x): x is string => !!x))];
  const namesById: Record<string, string> = {};
  if (staffIds.length > 0) {
    const { data: people, error: peopleError } = await supabase.from("profiles").select("id, full_name").in("id", staffIds);
    if (peopleError) {
      console.error("job report: profiles read failed:", peopleError.message);
      return { ok: false, status: 500, error: "Could not load the technicians' names." };
    }
    for (const p of people ?? []) if (p.full_name) namesById[p.id] = p.full_name;
  }

  const job = jobRes.data;
  const customer = Array.isArray(invoice.customers) ? invoice.customers[0] : invoice.customers;
  return {
    ok: true,
    context: {
      invoice: {
        id: invoice.id,
        invoice_number: invoice.invoice_number,
        title: invoice.title,
        customerName: (customer as { name?: string } | null)?.name ?? "",
      },
      job: { id: job.id, job_number: job.job_number, title: job.title },
      site: invoiceJobSite(invoice as Parameters<typeof invoiceJobSite>[0]),
      visits: groupVisitsByDay(entries, namesById),
      defaultNotes: composeDefaultNotes({
        stageNotes: stageRes.ok ? stageRes.rows : [],
        voiceReportTranscript: job.voice_report_transcript,
        completionNotes: job.completion_notes,
      }),
      photos: photosRes.ok ? photosRes.rows : [],
    },
  };
}

export interface JobReportDraft {
  jobNumber: number | null;
  jobTitle: string | null;
  defaultNotes: string;
  visits: { date: string; label: string; names: string[] }[];
  photos: { id: string; caption: string | null; createdAt: string; thumbUrl: string | null }[];
  /** Photos that can't go in a PDF (HEIC and the like). */
  unsupportedPhotos: number;
  signature: { signerName: string | null; createdAt: string; url: string | null } | null;
}

/** Sign many paths at once; a path Storage can't find is simply absent. */
async function signPaths(supabase: SupabaseClient, paths: string[]): Promise<Record<string, string>> {
  if (paths.length === 0) return {};
  const { data, error } = await supabase.storage.from("job-photos").createSignedUrls(paths, SIGNED_URL_TTL_S);
  if (error) {
    console.error("job report: signing photo URLs failed:", error.message);
    return {};
  }
  const out: Record<string, string> = {};
  for (const item of data ?? []) if (item.path && item.signedUrl && !item.error) out[item.path] = item.signedUrl;
  return out;
}

/** The dialog's draft: default notes, visits, eligible photos with thumbnail URLs, the sign-off. */
export async function buildJobReportDraft(supabase: SupabaseClient, ctx: JobReportContext): Promise<JobReportDraft> {
  const photos = eligiblePhotos(ctx.photos);
  const signature = latestSignature(ctx.photos);
  // Thumbnails first (lib/photo-thumbs.ts); originals for photos without one.
  const thumbs = await signPaths(supabase, photos.map((p) => thumbPathFor(p.storage_path!)));
  const noThumb = photos.filter((p) => !thumbs[thumbPathFor(p.storage_path!)]).map((p) => p.storage_path!);
  const originals = await signPaths(supabase, [...noThumb, ...(signature?.storage_path ? [signature.storage_path] : [])]);

  return {
    jobNumber: ctx.job.job_number,
    jobTitle: ctx.job.title,
    defaultNotes: ctx.defaultNotes,
    visits: ctx.visits.map((v) => ({ date: v.dateKey, label: v.label, names: v.names })),
    photos: photos.map((p) => ({
      id: p.id,
      caption: p.caption,
      createdAt: p.created_at,
      thumbUrl: thumbs[thumbPathFor(p.storage_path!)] ?? originals[p.storage_path!] ?? null,
    })),
    unsupportedPhotos: unsupportedPhotoCount(ctx.photos),
    signature: signature
      ? { signerName: signature.caption, createdAt: signature.created_at, url: originals[signature.storage_path!] ?? null }
      : null,
  };
}

/** Run `fn` over `items` with at most `limit` at once, keeping order. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Download one photo and re-encode it small. null when it can't be read. */
async function loadPhotoForPdf(supabase: SupabaseClient, path: string, maxEdge = PHOTO_MAX_EDGE): Promise<Buffer | null> {
  try {
    const { data, error } = await supabase.storage.from("job-photos").download(path);
    if (error || !data) {
      console.error("job report: photo download failed:", path, error?.message);
      return null;
    }
    const input = Buffer.from(await data.arrayBuffer());
    return await sharp(input, { failOn: "none" })
      .rotate() // bake EXIF orientation into the pixels
      .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: PHOTO_JPEG_QUALITY, mozjpeg: true })
      .toBuffer();
  } catch (err) {
    console.error("job report: photo could not be processed:", path, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Signature images stay PNG (they are line art); just bounded in size. */
async function loadSignatureForPdf(supabase: SupabaseClient, path: string): Promise<Buffer | null> {
  try {
    const { data, error } = await supabase.storage.from("job-photos").download(path);
    if (error || !data) {
      console.error("job report: signature download failed:", error?.message);
      return null;
    }
    return await sharp(Buffer.from(await data.arrayBuffer()), { failOn: "none" })
      .resize({ width: 800, height: 400, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .png()
      .toBuffer();
  } catch (err) {
    console.error("job report: signature could not be processed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export interface BuiltJobReport {
  buffer: Buffer;
  /** Office-facing note about photos left out, or null. */
  notice: string | null;
  photoCount: number;
}

/**
 * Render the report PDF for a request from the dialog. The requested photo
 * ids are intersected with this job's eligible photos — the client list is
 * never trusted. Throws only when the PDF itself can't be produced; a photo
 * that can't be read is left out and counted in `notice`.
 */
export async function buildJobReportPdf(
  supabase: SupabaseClient,
  ctx: JobReportContext,
  request: JobReportRequest,
): Promise<BuiltJobReport> {
  const chosen = selectRequestedPhotos(ctx.photos, request.photoIds);
  // Never download more than could possibly fit.
  const candidates = chosen.slice(0, MAX_REPORT_PHOTOS);
  const buffers = await mapLimited(candidates, PHOTO_CONCURRENCY, (p) => loadPhotoForPdf(supabase, p.storage_path!));
  const failed = buffers.filter((b) => b == null).length;
  const budget = applyPhotoBudget(buffers.map((b) => (b ? b.length : null)));
  const omittedForSize = budget.omitted + (chosen.length - candidates.length);

  const photos: JobReportPhoto[] = budget.kept.map((i) => ({
    image: { data: buffers[i]!, format: "jpg" },
    caption: candidates[i].caption,
    createdAt: candidates[i].created_at,
  }));

  let signature: { image: { data: Buffer; format: "png" } | null; signerName: string | null; createdAt: string } | null = null;
  const sigRow = request.includeSignature ? latestSignature(ctx.photos) : null;
  if (sigRow?.storage_path) {
    const img = await loadSignatureForPdf(supabase, sigRow.storage_path);
    signature = { image: img ? { data: img, format: "png" } : null, signerName: sigRow.caption, createdAt: sigRow.created_at };
  }

  const buffer = await renderJobReportPdf({
    business: businessInfo,
    invoiceNumber: ctx.invoice.invoice_number,
    jobNumber: ctx.job.job_number,
    jobTitle: ctx.job.title,
    customerName: ctx.invoice.customerName,
    site: ctx.site,
    visits: ctx.visits,
    notes: request.notes,
    photos,
    signature,
  });

  return {
    buffer,
    notice: reportNotice({ omittedForSize, failed, included: photos.length }),
    photoCount: photos.length,
  };
}
