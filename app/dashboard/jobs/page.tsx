import { createClient } from "@/lib/supabase/server";
import { getViewer } from "@/lib/auth/viewer";
import { JobsListClient } from "@/components/jobs/jobs-list-client";
// From a plain module, never from the "use client" file: a server component
// importing a value from a client module gets a reference, not the value.
import { BASE_COLUMNS, LIST_COLUMNS, PAGE_SIZE, latestStageByJob } from "@/lib/jobs-list";

export const dynamic = "force-dynamic";

// The unfiltered first page is fetched here, on the server next to the
// database, so the jobs list arrives with the page. It used to be fetched by
// the browser only after the whole client component had downloaded and
// started — the most-used list was also the slowest to show anything.
export default async function JobsPage() {
  const supabase = await createClient();
  const viewer = await getViewer();
  const role = viewer?.profile?.role;

  const run = (columns: string) =>
    supabase
      .from("jobs")
      .select(columns, { count: "exact" })
      .order("created_at", { ascending: false })
      .range(0, PAGE_SIZE - 1);
  let result = await run(LIST_COLUMNS);
  // Same 42703 fallback as the client (see LIST_COLUMNS).
  if (result.error?.code === "42703") result = await run(BASE_COLUMNS);

  const jobs = (result.data ?? []) as unknown as { id: string }[];
  let stages: ReturnType<typeof latestStageByJob> = new Map();
  if (!result.error && jobs.length > 0) {
    const { data: notes } = await supabase
      .from("job_stage_notes")
      .select("job_id, stage, created_at")
      .in("job_id", jobs.map((j) => j.id));
    // Non-fatal, as on the client: no badges rather than no list.
    stages = latestStageByJob(notes ?? []);
  }

  return (
    <JobsListClient
      initialJobs={result.error ? null : jobs}
      initialTotal={result.error ? null : result.count ?? null}
      initialStages={[...stages.entries()]}
      initialError={result.error?.message ?? null}
      canCreate={role === "admin" || role === "office"}
    />
  );
}
