// One-off setup script: creates the private "job-audio" Storage bucket used
// for job-completion voice reports, matching the existing job-photos /
// job-documents buckets (private, signed-URL access only).
//
// Usage: node --env-file=.env.local scripts/create-job-audio-bucket.mjs
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const BUCKET = "job-audio";

const { data: buckets, error: listError } = await supabase.storage.listBuckets();
if (listError) {
  console.error("Failed to list buckets:", listError.message);
  process.exit(1);
}

if (buckets.some((b) => b.name === BUCKET)) {
  console.log(`Bucket "${BUCKET}" already exists — nothing to do.`);
  process.exit(0);
}

const { error: createError } = await supabase.storage.createBucket(BUCKET, {
  public: false,
  fileSizeLimit: "25MB",
  allowedMimeTypes: ["audio/m4a", "audio/mp4", "audio/x-m4a", "audio/mpeg", "audio/wav", "audio/webm"],
});

if (createError) {
  console.error("Failed to create bucket:", createError.message);
  process.exit(1);
}

console.log(`Created private bucket "${BUCKET}".`);
