// Completing a job is per stage when it has several open (Justin, 22 Nov 2026:
// "when a job is marked as complete, it is only that cost centre / that stage
// of the job, not the whole job"). A stage is one line of the job's builder PO
// (po_cost_centers, completed_at from 0095); bookings and clock entries point
// at the same ids (cost_center_id).
//
// - No stages, or only one open: "Job complete" closes the job, as before, and
//   marks that one open stage complete too.
// - Two or more open: the sign-off ticks stages. The ticked ones are marked
//   complete and the job stays open, unless they are all the open ones, in
//   which case the job closes as before.
//
// Pure, names and ids only — never an amount (technicians use this). Mirrored
// byte for byte below the imports at mobile/lib/stageCompletion.ts
// (tests/unit/stage-completion-mirror.test.ts): change this file first.
import { occupiesDay } from "./scheduling";

export interface CompletionStage {
  id: string;
  name: string;
  completedAt: string | null;
}

/** The signer's own booking on the job (job_bookings), as far as this needs it. */
export interface StageBooking {
  starts_at: string;
  ends_at: string | null;
  daily: boolean;
  cost_center_id: string | null;
}

export type CompletionMode = "whole-job" | "per-stage";

export const STAGES_UNCHECKED_WARNING = "Couldn't check the job's stages — this will close the whole job.";

export const PICK_A_STAGE = "Tick at least one stage.";

export function openStages<S extends CompletionStage>(stages: S[] | null | undefined): S[] {
  return (stages ?? []).filter((s) => !s.completedAt);
}

/** Per stage once two or more are still open; otherwise the whole job, as before. */
export function completionMode(stages: CompletionStage[] | null | undefined): CompletionMode {
  return openStages(stages).length >= 2 ? "per-stage" : "whole-job";
}

/**
 * Which open stages start ticked: those of the signer's own bookings that
 * occupy today (Melbourne day key, the 0071 day rules), else the stage they
 * are clocked into, else none.
 */
export function defaultStageTicks(
  stages: CompletionStage[] | null | undefined,
  myBookings: StageBooking[] | null | undefined,
  todayKey: string,
  clockedCostCentreId: string | null | undefined
): string[] {
  const open = openStages(stages);
  const openIds = new Set(open.map((s) => s.id));
  const fromBookings = new Set<string>();
  for (const b of myBookings ?? []) {
    if (!b.cost_center_id || !openIds.has(b.cost_center_id)) continue;
    const window = { scheduled_start: b.starts_at, scheduled_end: b.ends_at, schedule_daily: b.daily };
    if (occupiesDay(window, todayKey)) fromBookings.add(b.cost_center_id);
  }
  if (fromBookings.size) return open.filter((s) => fromBookings.has(s.id)).map((s) => s.id);
  if (clockedCostCentreId && openIds.has(clockedCostCentreId)) return [clockedCostCentreId];
  return [];
}

export type CompletionPlan =
  | { ok: false; problem: string }
  | {
      ok: true;
      /** Stages to mark complete. */
      stageIds: string[];
      stageNames: string[];
      /** Close the whole job (status completed, ready to invoice)? */
      closesJob: boolean;
      /** Open stages left after this, when the job stays open. */
      remainingNames: string[];
    };

/**
 * What a sign-off does. `stages` null = the list couldn't be read: the whole
 * job closes, as before (the screen warns with STAGES_UNCHECKED_WARNING).
 */
export function planStageCompletion(stages: CompletionStage[] | null | undefined, tickedIds: Iterable<string>): CompletionPlan {
  const open = openStages(stages);
  if (completionMode(stages) === "whole-job") {
    return { ok: true, stageIds: open.map((s) => s.id), stageNames: open.map((s) => s.name), closesJob: true, remainingNames: [] };
  }
  const ticked = new Set(tickedIds);
  const chosen = open.filter((s) => ticked.has(s.id));
  if (!chosen.length) return { ok: false, problem: PICK_A_STAGE };
  const remaining = open.filter((s) => !ticked.has(s.id));
  return {
    ok: true,
    stageIds: chosen.map((s) => s.id),
    stageNames: chosen.map((s) => s.name),
    closesJob: remaining.length === 0,
    remainingNames: remaining.map((s) => s.name),
  };
}

/** "The job stays open for the other stages: X, Y." */
export function stagesStillOpenMessage(remainingNames: string[]): string {
  return `The job stays open for the other ${remainingNames.length === 1 ? "stage" : "stages"}: ${remainingNames.join(", ")}.`;
}

/** The confirm before saving: which stages close, and whether the job does. */
export function stageCompletionConfirm(plan: Extract<CompletionPlan, { ok: true }>): { title: string; message: string; button: string } {
  if (plan.closesJob) {
    const stagesLine = plan.stageNames.length ? ` Stage complete: ${plan.stageNames.join(", ")}.` : "";
    return {
      title: "Complete this job?",
      message: `This closes the whole job and sends it to the office to invoice.${stagesLine}`,
      button: "Complete job",
    };
  }
  return {
    title: plan.stageNames.length === 1 ? "Complete this stage?" : "Complete these stages?",
    message: `Stage complete: ${plan.stageNames.join(", ")}. ${stagesStillOpenMessage(plan.remainingNames)}`,
    button: plan.stageNames.length === 1 ? "Stage complete" : "Stages complete",
  };
}

/** The job note left when stages are signed off and the job stays open. */
export function stageSignOffNote(input: { stageNames: string[]; signedOffBy: string; date: string; remainingNames: string[] }): string {
  return [
    `Stage complete (${input.date}): ${input.stageNames.join(", ")}`,
    `Signed off by ${input.signedOffBy}`,
    stagesStillOpenMessage(input.remainingNames),
  ].join("\n");
}

export const STAGE_SIGNOFF_SOURCE = "stage_complete";

/**
 * The office's status drop-down set to Completed while stages are open: the
 * warning to confirm, or null when there is nothing to warn about.
 */
export function openStagesWarning(stages: CompletionStage[] | null | undefined): string | null {
  const open = openStages(stages);
  if (!open.length) return null;
  return `These stages aren't marked complete yet: ${open.map((s) => s.name).join(", ")}. Completing the job closes all of them for scheduling. Continue?`;
}
