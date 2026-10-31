// The "Today" card at the top of a job (Stage 6 of the 31 Oct 2026 workflow
// review). Justin: "On arrival, the app should prompt the crew through the
// next steps. It should feel like a guided checklist: arrive and clock on,
// check the materials needed, order materials, confirm deliveries, record
// progress, complete the job." And: "The app leads the day. On opening a job,
// show the next step and what is outstanding."
//
// Every step is ticked off from what has already been recorded — nothing is
// typed twice to tick a box. Pure, so the rules are tested without a screen.

export type StepKey = "clock" | "materials" | "deliveries" | "progress" | "finish";
export type StepState = "done" | "next" | "todo" | "optional";

export interface TodayStep {
  key: StepKey;
  title: string;
  detail: string;
  state: StepState;
}

export interface TodayInputs {
  /** ISO time of my open work entry on this job, or null. */
  clockedInSince: string | null;
  /** This job's supplier orders; null when they couldn't be loaded (no signal). */
  orders: { status: string; deliveredAt?: string | null }[] | null;
  signedOff: boolean;
  /** Formats a clock-in time for display ("7:02 am"). */
  formatTime: (iso: string) => string;
}

export function todaySteps(i: TodayInputs): TodayStep[] {
  const live = (i.orders ?? []).filter((o) => o.status !== "cancelled");
  const waiting = live.filter((o) => o.status === "ordered" && !o.deliveredAt).length;

  const steps: TodayStep[] = [
    {
      key: "clock",
      title: "Clock on",
      detail: i.clockedInSince
        ? `On since ${i.formatTime(i.clockedInSince)}`
        : i.signedOff
          ? "Job signed off"
          : "Tap when you arrive (auto clock may already have)",
      state: i.clockedInSince || i.signedOff ? "done" : "todo",
    },
    {
      key: "materials",
      title: "Order materials",
      detail:
        i.orders === null
          ? "Orders need signal"
          : live.length === 0
            ? "Nothing ordered yet. Order what you need from the supplier"
            : `${live.length} PO${live.length === 1 ? "" : "s"} raised`,
      state: live.length > 0 ? "done" : "optional",
    },
    {
      key: "deliveries",
      title: "Confirm deliveries",
      detail:
        live.length === 0
          ? "Nothing to deliver"
          : waiting === 0
            ? "All delivered"
            : `${waiting} waiting. Tap Delivered when it turns up`,
      state: live.length === 0 ? "optional" : waiting === 0 ? "done" : "todo",
    },
    {
      key: "progress",
      title: "Record progress",
      detail: "Photos, notes and variations",
      state: "optional",
    },
    {
      key: "finish",
      title: "Complete the job",
      detail: i.signedOff ? "Signed off" : finishDetail(waiting),
      state: i.signedOff ? "done" : "todo",
    },
  ];

  // The first step still to do is the one the card points at.
  const next = steps.find((s) => s.state === "todo");
  if (next) next.state = "next";
  return steps;
}

function finishDetail(waiting: number): string {
  const outstanding = waiting > 0 ? `${waiting} deliver${waiting === 1 ? "y" : "ies"} not confirmed. ` : "";
  return `${outstanding}Customer signs, and you're clocked off`;
}
