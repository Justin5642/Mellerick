import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ADDED_BY_TECHNICIAN,
  NO_OPEN_STAGES,
  PICK_A_STAGE_TO_START,
  isAddedByTechnician,
  openStartStages,
  preselectedStartStage,
  runningBookingEnd,
  startStageLabel,
  startStageProblem,
  startWorkQuestion,
  withRunningEnds,
  type StartStage,
} from "@/lib/self-start-booking";
import { closedJobSentence, parseSelfStartBody, selfStartRpcError } from "@/lib/self-start";
import { fromBusinessInputValue } from "@/lib/date";

const stage = (id: string, name: string, completedAt: string | null = null, costCentre: string | null = null): StartStage => ({
  id,
  name,
  costCentre,
  completedAt,
});
const melb = (local: string) => fromBusinessInputValue(local);

describe("picking the stage to start on", () => {
  const drainage = stage("a", "Drainage");
  const rough = stage("b", "Rough in", "2026-11-20T00:00:00Z");
  const fitOff = stage("c", "Fit off");

  it("never offers a completed stage", () => {
    expect(openStartStages([drainage, rough, fitOff]).map((s) => s.id)).toEqual(["a", "c"]);
  });

  it("preselects only when exactly one stage is open", () => {
    expect(preselectedStartStage([drainage, rough])).toBe("a");
    expect(preselectedStartStage([drainage, rough, fitOff])).toBeNull();
    expect(preselectedStartStage([rough])).toBeNull();
    expect(preselectedStartStage(null)).toBeNull();
  });

  it("refuses no pick, a completed pick, an unknown pick, and a job with no open stage", () => {
    expect(startStageProblem([drainage, fitOff], null)).toBe(PICK_A_STAGE_TO_START);
    expect(startStageProblem([drainage, rough], "b")).toBe(PICK_A_STAGE_TO_START);
    expect(startStageProblem([drainage], "zzz")).toBe(PICK_A_STAGE_TO_START);
    expect(startStageProblem([rough], "b")).toBe(NO_OPEN_STAGES);
    expect(startStageProblem([], null)).toBe(NO_OPEN_STAGES);
    expect(startStageProblem([drainage, fitOff], "c")).toBeNull();
  });

  it("labels and asks", () => {
    expect(startStageLabel(stage("x", "Stage 2", null, "Drainage"))).toBe("Stage 2 (Drainage)");
    expect(startStageLabel(stage("x", "Drainage", null, "drainage"))).toBe("Drainage");
    expect(startWorkQuestion(123, stage("x", "Stage 2", null, "Drainage"))).toBe("Clock on to #123 — Stage 2 (Drainage)?");
    expect(startWorkQuestion(null, drainage)).toBe("Clock on to this job — Drainage?");
  });
});

describe("Added by technician", () => {
  const roles: Record<string, string> = { tom: "technician", olive: "office" };
  const roleOf = (id: string) => roles[id];

  it("tags a technician's booking of themselves only", () => {
    expect(isAddedByTechnician({ staff_id: "tom", created_by: "tom" }, roleOf)).toBe(true);
    expect(isAddedByTechnician({ staff_id: "tom", created_by: "olive" }, roleOf)).toBe(false);
    expect(isAddedByTechnician({ staff_id: "olive", created_by: "olive" }, roleOf)).toBe(false);
    expect(isAddedByTechnician({ staff_id: "tom", created_by: null }, roleOf)).toBe(false);
    expect(isAddedByTechnician({ staff_id: "tom" }, roleOf)).toBe(false);
    expect(isAddedByTechnician({ staff_id: "ghost", created_by: "ghost" }, roleOf)).toBe(false);
    expect(ADDED_BY_TECHNICIAN).toBe("Added by technician");
  });
});

describe("a running self-started booking on the boards", () => {
  const start = melb("2026-11-25T09:12");

  it("runs to 15:30 while it's earlier than that", () => {
    expect(runningBookingEnd(start, Date.parse(melb("2026-11-25T10:00")))).toBe(melb("2026-11-25T15:30"));
  });

  it("runs to now after 15:30", () => {
    expect(runningBookingEnd(start, Date.parse(melb("2026-11-25T17:45")))).toBe(melb("2026-11-25T17:45"));
  });

  it("never runs past its own day (a forgotten clock-off)", () => {
    expect(runningBookingEnd(start, Date.parse(melb("2026-11-28T08:00")))).toBe(melb("2026-11-25T23:59"));
  });

  it("a late start shows at least half an hour", () => {
    const late = melb("2026-11-25T18:00");
    expect(runningBookingEnd(late, Date.parse(melb("2026-11-25T18:05")))).toBe(melb("2026-11-25T18:30"));
  });

  it("only open, self-started bookings are stretched", () => {
    const roleOf = (id: string) => (id === "tom" ? "technician" : "office");
    const base = { starts_at: start, ends_at: null as string | null, daily: false };
    const out = withRunningEnds(
      [
        { ...base, id: "self", staff_id: "tom", created_by: "tom" },
        { ...base, id: "office", staff_id: "tom", created_by: "olive" },
        { ...base, id: "ended", staff_id: "tom", created_by: "tom", ends_at: melb("2026-11-25T11:00") },
      ],
      roleOf,
      Date.parse(melb("2026-11-25T10:00"))
    );
    expect(out[0]).toMatchObject({ ends_at: melb("2026-11-25T15:30"), running: true });
    expect(out[1].ends_at).toBeNull();
    expect(out[2]).toMatchObject({ ends_at: melb("2026-11-25T11:00") });
    expect(out[2]).not.toHaveProperty("running");
  });
});

describe("the route's request and refusals", () => {
  const u = "11111111-1111-4111-8111-111111111111";
  it("takes three uuids", () => {
    expect(parseSelfStartBody({ bookingId: u, costCenterId: u, entryId: u })).toEqual({ bookingId: u, costCenterId: u, entryId: u });
    expect(parseSelfStartBody({ bookingId: u, costCenterId: "x", entryId: u })).toBeNull();
    expect(parseSelfStartBody(null)).toBeNull();
  });
  it("closed job uses 0096's words", () => {
    expect(closedJobSentence(7, "cancelled")).toBe("Job #7 is cancelled. A cancelled job can't be scheduled — reopen it first.");
  });
  it("maps codes to fixed sentences", () => {
    expect(selfStartRpcError({ code: "42883" }, null).status).toBe(409);
    expect(selfStartRpcError({ code: "MJ111" }, null).status).toBe(403);
    expect(selfStartRpcError({ code: "MJ001" }, { jobNumber: 4, status: "completed" }).error).toMatch(/^Job #4 is completed/);
    expect(selfStartRpcError({ code: "23505", message: "leak" }, null)).toEqual({ status: 500, error: "Couldn't start work on this job. Try again." });
  });
});

describe("lib/self-start-booking.ts and mobile/lib/selfStartBooking.ts", () => {
  const fromImports = (p: string) => {
    const lines = readFileSync(join(process.cwd(), p), "utf8").split("\n");
    const first = lines.findIndex((l) => l.startsWith("import "));
    expect(first).toBeGreaterThan(-1);
    return lines.slice(first).join("\n");
  };
  it("are identical from the imports on", () => {
    expect(fromImports("mobile/lib/selfStartBooking.ts")).toBe(fromImports("lib/self-start-booking.ts"));
  });
});
