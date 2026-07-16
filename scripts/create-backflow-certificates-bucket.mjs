// One-off setup script: creates the private "backflow-certificates" Storage
// bucket used to archive the generated PDF report for every backflow test
// (the same PDF that gets emailed to the water authority), matching the
// existing job-photos / job-documents / job-audio buckets (private,
// signed-URL access only).
//
// Usage: node --env-file=.env.local scripts/create-backflow-certificates-bucket.mjs
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const BUCKET = "backflow-certificates";
// Holds both the generated report PDF and the tester's signature PNG
// captured on the test form (same canvas-signature approach as job sign-off).
const BUCKET_OPTS = {
  public: false,
  fileSizeLimit: "10MB",
  allowedMimeTypes: ["application/pdf", "image/png"],
};

const { data: buckets, error: listError } = await supabase.storage.listBuckets();
if (listError) {
  console.error("Failed to list buckets:", listError.message);
  process.exit(1);
}

if (buckets.some((b) => b.name === BUCKET)) {
  const { error: updateError } = await supabase.storage.updateBucket(BUCKET, BUCKET_OPTS);
  if (updateError) {
    console.error(`Bucket "${BUCKET}" already exists but failed to update its settings:`, updateError.message);
    process.exit(1);
  }
  console.log(`Bucket "${BUCKET}" already existed — updated its allowed mime types.`);
  process.exit(0);
}

const { error: createError } = await supabase.storage.createBucket(BUCKET, BUCKET_OPTS);

if (createError) {
  console.error("Failed to create bucket:", createError.message);
  process.exit(1);
}

console.log(`Created private bucket "${BUCKET}".`);
