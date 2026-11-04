import { call } from "./supplierOrders";

// A job's stages — the lines of its builder PO — and which are complete
// (0095 — DRAFT, not applied yet; Justin, 4 Nov 2026). Read from the office
// server: the phone's own copy has no completion. Finishing a stage goes
// through the outbox (SignatureRepository.finishForToday), so it works offline.

export interface JobStageStatus {
  id: string;
  name: string;
  costCentre: string | null;
  poNumber: string;
  completedAt: string | null;
  completedBy: string | null;
}

export async function loadJobStages(jobId: string): Promise<JobStageStatus[]> {
  const res = await call<{ stages: JobStageStatus[] }>(`/api/jobs/${jobId}/stages`);
  return res.stages;
}

/** Is this job booked over more than one day, ending after today? */
export function isMultiDay(job: { scheduled_start: string | null; scheduled_end: string | null; schedule_daily?: boolean | number | null }, now: Date = new Date()): boolean {
  if (!job.scheduled_start || !job.scheduled_end) return !!job.schedule_daily;
  const start = new Date(job.scheduled_start);
  const end = new Date(job.scheduled_end);
  const dayKey = (d: Date) => d.getFullYear() * 10000 + d.getMonth() * 100 + d.getDate();
  if (dayKey(end) === dayKey(start)) return false;
  return dayKey(end) > dayKey(now);
}
