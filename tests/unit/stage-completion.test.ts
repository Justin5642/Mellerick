import { describe, it, expect } from "vitest";
import {
  completionMode,
  defaultStageTicks,
  openStagesWarning,
  planStageCompletion,
  stageCompletionConfirm,
  stageSignOffNote,
  stagesStillOpenMessage,
  PICK_A_STAGE,
} from "@/lib/stage-completion";

const sewer = { id: "s1", name: "Sewer", completedAt: null };
const storm = { id: "s2", name: "Stormwater", completedAt: null };
const cartage = { id: "s3", name: "Cartage", completedAt: null };
const done = { id: "s0", name: "Set-out", completedAt: "2026-11-01T00:00:00Z" };

// Melbourne is UTC+11 in November: 2026-11-23T21:00Z = Tue 24 Nov 08:00.
const bookingOn = (cc: string | null, startIso: string, endIso: string, daily = false) => ({
  starts_at: startIso,
  ends_at: endIso,
  daily,
  cost_center_id: cc,
});

describe("completionMode", () => {
  it("is the whole job with no stages, unknown stages or one open stage", () => {
    expect(completionMode(null)).toBe("whole-job");
    expect(completionMode([])).toBe("whole-job");
    expect(completionMode([sewer])).toBe("whole-job");
    expect(completionMode([sewer, done])).toBe("whole-job");
  });
  it("is per stage with two or more open", () => {
    expect(completionMode([sewer, storm])).toBe("per-stage");
    expect(completionMode([sewer, storm, done])).toBe("per-stage");
  });
});

describe("planStageCompletion", () => {
  it("closes the job as before when there are no stages or they couldn't load", () => {
    expect(planStageCompletion(null, [])).toEqual({ ok: true, stageIds: [], stageNames: [], closesJob: true, remainingNames: [] });
    expect(planStageCompletion([], ["x"])).toMatchObject({ ok: true, closesJob: true, stageIds: [] });
  });
  it("closes the job and its one open stage", () => {
    expect(planStageCompletion([done, sewer], [])).toEqual({
      ok: true,
      stageIds: ["s1"],
      stageNames: ["Sewer"],
      closesJob: true,
      remainingNames: [],
    });
  });
  it("needs a tick with several open", () => {
    expect(planStageCompletion([sewer, storm], [])).toEqual({ ok: false, problem: PICK_A_STAGE });
    expect(planStageCompletion([sewer, storm], ["s0", "nope"])).toEqual({ ok: false, problem: PICK_A_STAGE });
  });
  it("completes only the ticked stages and keeps the job open", () => {
    expect(planStageCompletion([sewer, storm, cartage, done], ["s2"])).toEqual({
      ok: true,
      stageIds: ["s2"],
      stageNames: ["Stormwater"],
      closesJob: false,
      remainingNames: ["Sewer", "Cartage"],
    });
  });
  it("closes the job when every open stage is ticked", () => {
    expect(planStageCompletion([sewer, storm, done], ["s1", "s2", "s0"])).toMatchObject({
      ok: true,
      stageIds: ["s1", "s2"],
      closesJob: true,
      remainingNames: [],
    });
  });
});

describe("defaultStageTicks", () => {
  const stages = [sewer, storm, cartage, done];
  it("ticks the stages of the signer's own bookings today", () => {
    const mine = [
      bookingOn("s2", "2026-11-23T20:00:00Z", "2026-11-24T04:30:00Z"),
      bookingOn("s3", "2026-11-23T20:00:00Z", "2026-11-24T04:30:00Z"),
      bookingOn("s1", "2026-11-24T20:00:00Z", "2026-11-25T04:30:00Z"), // tomorrow
    ];
    expect(defaultStageTicks(stages, mine, "2026-11-24", "s1")).toEqual(["s2", "s3"]);
  });
  it("counts each day of a daily booking", () => {
    const mine = [bookingOn("s1", "2026-11-22T20:00:00Z", "2026-11-26T04:30:00Z", true)];
    expect(defaultStageTicks(stages, mine, "2026-11-25", null)).toEqual(["s1"]);
  });
  it("ignores bookings on a completed stage or with no cost centre, then uses the clock", () => {
    const mine = [bookingOn("s0", "2026-11-23T20:00:00Z", "2026-11-24T04:30:00Z"), bookingOn(null, "2026-11-23T20:00:00Z", "2026-11-24T04:30:00Z")];
    expect(defaultStageTicks(stages, mine, "2026-11-24", "s3")).toEqual(["s3"]);
  });
  it("ticks nothing without a booking today or an open clocked stage", () => {
    expect(defaultStageTicks(stages, null, "2026-11-24", null)).toEqual([]);
    expect(defaultStageTicks(stages, [], "2026-11-24", "s0")).toEqual([]);
  });
});

describe("wording", () => {
  it("says which stages stay open", () => {
    expect(stagesStillOpenMessage(["Sewer"])).toBe("The job stays open for the other stage: Sewer.");
    expect(stagesStillOpenMessage(["Sewer", "Cartage"])).toBe("The job stays open for the other stages: Sewer, Cartage.");
  });
  it("confirms a stage, or the whole job", () => {
    const stage = planStageCompletion([sewer, storm], ["s1"]);
    if (!stage.ok) throw new Error("plan");
    expect(stageCompletionConfirm(stage)).toEqual({
      title: "Complete this stage?",
      message: "Stage complete: Sewer. The job stays open for the other stage: Stormwater.",
      button: "Stage complete",
    });
    const whole = planStageCompletion([sewer, storm], ["s1", "s2"]);
    if (!whole.ok) throw new Error("plan");
    expect(stageCompletionConfirm(whole).title).toBe("Complete this job?");
    expect(stageCompletionConfirm(whole).message).toContain("Sewer, Stormwater");
  });
  it("writes the job note", () => {
    expect(stageSignOffNote({ stageNames: ["Sewer"], signedOffBy: "customer Jo", date: "24/11/2026", remainingNames: ["Cartage"] })).toBe(
      "Stage complete (24/11/2026): Sewer\nSigned off by customer Jo\nThe job stays open for the other stage: Cartage."
    );
  });
  it("warns the office about open stages", () => {
    expect(openStagesWarning([done])).toBeNull();
    expect(openStagesWarning(null)).toBeNull();
    expect(openStagesWarning([sewer, done, storm])).toContain("Sewer, Stormwater");
  });
});
