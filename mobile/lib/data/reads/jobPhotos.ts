import { supabase } from "../../supabase";
import { fromLocalOr } from "./source";
import { unwrap, unwrapRows } from "./unwrap";

// Job photo list for the Photos tab. job_photos rides both the technician stream
// (tech_job_photos — assigned jobs, named columns) and the office stream, so the
// list is served from the device mirror: opening the tab costs no network round
// trip, and it works in a basement.
//
// The column set is exactly what tech_job_photos syncs; caption and
// simpro_file_id are not in the technician stream, so neither side selects them
// (the shapes must be identical whichever side answers).
export interface JobPhoto {
  id: string;
  job_id: string;
  storage_path: string;
  photo_type: string;
  uploaded_by: string | null;
  created_at: string;
}

const SELECT = "id, job_id, storage_path, photo_type, uploaded_by, created_at";

export const SQL_LIST_JOB_PHOTOS = `
  SELECT id, job_id, storage_path, photo_type, uploaded_by, created_at
  FROM job_photos WHERE job_id = ?
  ORDER BY created_at DESC, id DESC`;

// A technician's mirror holds only the jobs they are assigned to (tech_jobs and
// tech_job_photos share that scope), but RLS lets them read any job. An empty
// local list for a job that is NOT in the mirror means "not synced here", not
// "no photos" — so, like getJob, defer to Supabase rather than render an empty
// grid that reads as the job's evidence having vanished.
export const SQL_JOB_IS_LOCAL = `SELECT id FROM jobs WHERE id = ?`;

export async function listJobPhotos(jobId: string): Promise<JobPhoto[]> {
  const remote = async (): Promise<JobPhoto[]> => {
    const res = await supabase
      .from("job_photos")
      .select(SELECT)
      .eq("job_id", jobId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });
    return unwrapRows(res as never, "listJobPhotos") as unknown as JobPhoto[];
  };
  return fromLocalOr(async (db) => {
    const job = await db.getOptional<{ id: string }>(SQL_JOB_IS_LOCAL, [jobId]);
    if (!job) return remote();
    return db.getAll<JobPhoto>(SQL_LIST_JOB_PHOTOS, [jobId]);
  }, remote);
}

export const JOB_PHOTOS_BUCKET = "job-photos";
const SIGNED_URL_TTL_S = 3600;

// Signed URLs for many photos in ONE Storage request (was one request per
// photo). Supabase-only: signed URLs are network-only by nature.
//
// Returns path → URL for every path Storage signed. A path it could not sign
// (object missing, per-item error) is simply absent, so the caller can mark that
// cell "didn't load"; a request-level ERROR throws, like every other read here.
//
// Each call mints new tokens, so a URL is NOT a cache identity — render with a
// cacheKey of the storage path (see components/job/photos.tsx).
export async function signJobPhotoUrls(paths: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(paths)];
  if (unique.length === 0) return {};
  const res = await supabase.storage.from(JOB_PHOTOS_BUCKET).createSignedUrls(unique, SIGNED_URL_TTL_S);
  const rows = (unwrap(res as never, "signJobPhotoUrls") ?? []) as {
    path: string | null;
    signedUrl: string | null;
    error: string | null;
  }[];
  const out: Record<string, string> = {};
  for (const r of rows) if (r.path && r.signedUrl && !r.error) out[r.path] = r.signedUrl;
  return out;
}
