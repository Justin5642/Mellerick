import { listMyJobs } from "./data/reads/jobs";
import { withMyBookings } from "./data/reads/bookings";
import { withCompletedStages } from "./data/reads/clockStages";
import { listMyOpenWorkEntries } from "./data/reads/clock";
import { depotCoords, readClockAnchors } from "./clockPrompts";
import { geocodeSiteAddress } from "./officeActions";
import { DEPOT_ADDRESS, todayKey, unpinnedJobsToday, type PromptContext, type PromptSite } from "./dwellPrompt";

// Builds the clock prompts' view of the technician's day (lib/dwellPrompt.ts
// PromptContext) from the data layer. Foreground only — the background task
// reads what this publishes. Local-first reads, so it works offline.

/** The tracking gate's own role rule (lib/trackingGate.ts decideTracking). */
export function promptsEnabled(role: string | null | undefined, autoClock: boolean | null | undefined): boolean {
  if (autoClock === false) return false;
  if (autoClock !== true && role != null && role !== "technician") return false;
  return true;
}

export async function buildPromptContext(input: {
  staffId: string;
  role: string | null | undefined;
  autoClock: boolean | null | undefined;
  pinnedSites: PromptSite[];
  nowMs?: number;
}): Promise<PromptContext> {
  const nowMs = input.nowMs ?? Date.now();
  const day = todayKey(nowMs);
  const enabled = promptsEnabled(input.role, input.autoClock);
  if (!enabled) {
    return { staffId: input.staffId, enabled, dayKey: day, candidates: [], openEntries: [], pinnedSites: [], depot: null };
  }
  const jobs = await listMyJobs(input.staffId);
  const withBookings = await withMyBookings(
    input.staffId,
    jobs.map((j) => ({ ...j, jobId: j.id }))
  );
  // Completed stages (best-effort, online — 0118 (draft)): a prompted clock-on never
  // lands on a stage already marked complete.
  const candidates = unpinnedJobsToday(await withCompletedStages(withBookings), day);
  const [open, anchors, depot] = await Promise.all([
    listMyOpenWorkEntries(input.staffId),
    readClockAnchors(),
    depotCoords(async () => {
      try {
        const pin = await geocodeSiteAddress(DEPOT_ADDRESS);
        return { lat: pin.lat, lng: pin.lng };
      } catch (e) {
        // "Couldn't find that exact address" is an answer; anything else is no signal.
        if (e instanceof Error && /find that exact address/i.test(e.message)) return null;
        throw e;
      }
    }),
  ]);
  return {
    staffId: input.staffId,
    enabled,
    dayKey: day,
    candidates,
    openEntries: open.map((e) => ({ ...e, anchor: anchors[e.entryId] ?? null })),
    pinnedSites: input.pinnedSites.map((s) => ({ lat: s.lat, lng: s.lng, ...(s.radiusM ? { radiusM: s.radiusM } : {}) })),
    depot,
  };
}
