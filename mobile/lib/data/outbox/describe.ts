import type { Operation } from "./types";

// Plain-English labels for the "not synced" sheet, so a refused change can be
// recognised ("Time entry change · 14 Nov 7:31pm") instead of being a number
// on a red pill. Pure: tested in describe.test.ts.

const TABLE_LABELS: Record<string, string> = {
  jobs: "Job",
  job_photos: "Photo",
  time_entries: "Time entry",
  customers: "Customer",
  job_expenses: "Expense",
  sites: "Site",
  job_variations: "Variation",
  job_bookings: "Booking",
  equipment_usage_log: "Truck / plant usage",
  pricing_items: "Price list item",
  job_notes: "Job note",
  job_items: "Job line item",
  equipment_expenses: "Vehicle expense",
  invoices: "Invoice",
  inventory: "Stock item",
  equipment: "Vehicle / plant",
  cost_center_templates: "Cost centre template",
  backflow_tests: "Backflow test",
  backflow_devices: "Backflow device",
  variation_types: "Variation type",
  quotes: "Quote",
  job_stage_notes: "Stage note",
};

const EFFECT_LABELS: Record<string, string> = {
  "assign-technicians": "Assigning technicians",
  "backflow-submit": "Submitting a backflow test",
  "stage-complete": "Marking a stage complete",
  "sync-billing": "Updating billing",
  "sync-calendar": "Updating the calendar",
  "sync-job-billing": "Updating job billing",
  "transcribe-voice-report": "Transcribing a voice report",
};

const VERB: Record<string, string> = { insert: "New", update: "Change to", delete: "Deleting" };

export function describeOperation(op: Operation): string {
  if (op.kind === "side_effect") return EFFECT_LABELS[op.effect] ?? `Background task (${op.effect})`;
  const thing = TABLE_LABELS[op.table] ?? op.table.replace(/_/g, " ");
  // A job update that only sets status = completed is the sign-off.
  if (op.table === "jobs" && op.op === "update" && op.payload?.status === "completed") return "Completing a job";
  const verb = VERB[op.op] ?? op.op;
  return verb === "New" ? `New ${thing.toLowerCase()}` : `${verb} ${thing === "Job" ? "a job" : `a ${thing.toLowerCase()}`}`;
}

/**
 * What the server's refusal means, in words a tech can act on. The raw text
 * is always shown underneath too — this only adds a translation for the
 * refusals the database is known to give.
 */
export function explainError(error: string | null | undefined): string {
  const e = (error ?? "").toLowerCase();
  if (!e) return "The server refused it without saying why.";
  if (e.includes("dependency failed")) return "It needed an earlier change that also didn't sync.";
  if (e.includes("crashed repeatedly")) return "The app kept closing while sending it.";
  if (e.includes("has been billed")) return "That time is already billed — only the office can change it now.";
  if (e.includes("can't be scheduled") || e.includes("can\u2019t be scheduled") || e.includes("mj001") || e.includes("closed job")) {
    return "The job was already completed or cancelled, so it can't be scheduled or changed like this.";
  }
  if (e.includes("duplicate key") || e.includes("23505") || e.includes("already exists")) return "The office already has this — it was probably saved twice.";
  if (e.includes("row-level security") || e.includes("42501") || e.includes("permission denied") || e.includes("only office") || e.includes("office/admin")) {
    return "Your login isn't allowed to make this change (it may be on a job you're no longer on). Ask the office.";
  }
  if (e.includes("violates check constraint") || e.includes("23514")) return "The server rejected a value in it (for example, a clock-off before the clock-on).";
  if (e.includes("violates foreign key") || e.includes("23503")) return "Something it points to (a job, site or entry) no longer exists.";
  if (e.includes("jwt") || e.includes("session")) return "Your sign-in had expired. Retry after signing in again.";
  return "The server refused it.";
}

export function whenQueued(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}
