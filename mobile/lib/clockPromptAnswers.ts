import type { ClockFix } from "./clockFix";
import {
  SITE_PIN_MAX_ACCURACY_M,
  acceptClockOn,
  answerLate,
  declineClockOn,
  promptCostCentre,
  snoozeLeftSite,
  timeOfDay,
  toClockFix,
  type ClockPrompt,
  type PromptState,
} from "./dwellPrompt";
import type { ClockPromptAnswer } from "../components/ClockPromptSheet";

// What each answer to a clock prompt does (lib/dwellPrompt.ts). Every clock
// write goes through the outbox (TimeEntriesRepository), so a Yes with no
// signal still lands; only the site pin needs signal. Dependencies are passed
// in, so this is tested with fakes.

export interface ClockPromptAnswerDeps {
  staffId: string;
  /** Latest open work entry of the technician's, anywhere. */
  getOpenWorkEntry(): Promise<{ clockInIso: string } | null>;
  getOpenWorkEntryOnJob(jobId: string): Promise<{ id: string; clockInIso: string } | null>;
  /** The job's own scheduled cost centre (the fallback after bookings). */
  getJobCostCentre(jobId: string): Promise<string | null>;
  clockIn(input: { jobId: string; staffId: string; costCenterId: string | null; fix: ClockFix | null; atIso: string }): Promise<string>;
  clockOut(input: { entryId: string; clockInIso: string; fix: ClockFix | null; atIso?: string }): Promise<void>;
  /** Whether the job's site has a pin: online only; "unknown" offline. */
  readSitePin(jobId: string): Promise<"pinned" | "unpinned" | "no-site" | "unknown">;
  postSiteLocation(jobId: string, fix: ClockFix): Promise<void>;
  currentFix(): Promise<ClockFix | null>;
}

export interface AnswerOutcome {
  /** How the prompt state changes (identity when nothing should). */
  change: (s: PromptState) => PromptState;
  /** What to tell the technician, if anything. */
  message: { title: string; body: string } | null;
}

const same = (s: PromptState) => s;

function errorText(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

export async function carryOutAnswer(prompt: ClockPrompt, answer: ClockPromptAnswer, deps: ClockPromptAnswerDeps): Promise<AnswerOutcome> {
  if (prompt.kind === "clock-on") {
    if (answer.kind !== "clock-on") return { change: (s) => declineClockOn(s, prompt), message: null };
    const candidate = prompt.candidates.find((c) => c.jobId === answer.jobId);
    if (!candidate) return { change: same, message: null };

    // Clocked on some other way meanwhile: say so, ask nothing more about this stay.
    const open = await deps.getOpenWorkEntry().catch(() => null);
    if (open) {
      return {
        change: (s) => ({ ...s, dwell: null }),
        message: { title: "Already clocked on", body: "You're already clocked on, so nothing was changed." },
      };
    }

    const atMs = prompt.startFix.atMs;
    const jobLevel = await deps.getJobCostCentre(candidate.jobId).catch(() => null);
    const costCenterId = promptCostCentre({ ...candidate, scheduledCostCenterId: candidate.scheduledCostCenterId ?? jobLevel }, atMs);
    try {
      await deps.clockIn({
        jobId: candidate.jobId,
        staffId: deps.staffId,
        costCenterId,
        fix: toClockFix(prompt.startFix),
        atIso: new Date(atMs).toISOString(),
      });
    } catch (e) {
      return { change: same, message: { title: "Couldn't clock on", body: errorText(e, "Try again from the job's Time tab.") } };
    }

    const clocked = `Clocked on from ${timeOfDay(atMs)}, when you stopped here.`;
    const change = (s: PromptState) => acceptClockOn(s, candidate.jobId);
    const best = prompt.bestFix;
    // Pin the site — only with a fix the server accepts, only when it has no pin (never move one).
    if (best.accuracy === null || best.accuracy > SITE_PIN_MAX_ACCURACY_M) {
      return { change, message: { title: "Clocked on", body: `${clocked} Your location wasn't precise enough to save as the site's map pin.` } };
    }
    const pin = await deps.readSitePin(candidate.jobId).catch(() => "unknown" as const);
    if (pin === "pinned" || pin === "no-site") return { change, message: { title: "Clocked on", body: clocked } };
    if (pin === "unknown") {
      return { change, message: { title: "Clocked on", body: `${clocked} The site's map pin needs signal to save — it wasn't saved this time.` } };
    }
    try {
      await deps.postSiteLocation(candidate.jobId, toClockFix(best));
      return { change, message: { title: "Clocked on", body: `${clocked} The site's location is saved, so auto clock-on will work here from now on.` } };
    } catch (e) {
      return { change, message: { title: "Clocked on", body: `${clocked} The site's location couldn't be saved: ${errorText(e, "try again from the job's Overview.")}` } };
    }
  }

  if (answer.kind !== "clock-off") {
    if (prompt.kind === "left-site") return { change: (s) => snoozeLeftSite(s, prompt.entry.entryId, Date.now()), message: null };
    return { change: (s) => answerLate(s, prompt.entry.entryId, prompt.hour), message: null };
  }

  const open = await deps.getOpenWorkEntryOnJob(prompt.entry.jobId).catch(() => null);
  if (!open || open.id !== prompt.entry.entryId) {
    return { change: same, message: { title: "Already clocked off", body: "That entry is already closed, so nothing was changed." } };
  }
  try {
    if (prompt.kind === "left-site") {
      const atMs = prompt.leftFix.atMs;
      await deps.clockOut({ entryId: open.id, clockInIso: open.clockInIso, fix: toClockFix(prompt.leftFix), atIso: new Date(atMs).toISOString() });
      return { change: same, message: { title: "Clocked off", body: `Clocked off at ${timeOfDay(atMs)}, when you left the site.` } };
    }
    await deps.clockOut({ entryId: open.id, clockInIso: open.clockInIso, fix: await deps.currentFix().catch(() => null) });
    return { change: same, message: { title: "Clocked off", body: "Clocked off." } };
  } catch (e) {
    return { change: same, message: { title: "Couldn't clock off", body: errorText(e, "Try again from the job's Time tab.") } };
  }
}
