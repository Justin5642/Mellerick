// Logging a mistake on a job — the crew's side (Justin, 25 Nov 2026: "crew
// raise, office costs"). The fixed cause list, the statuses, the form → request
// rule, and the sentences the route answers with. No money: the crew never
// enter or see a dollar figure. The database function raise_job_mistake()
// (migration 0119 (a draft, not applied yet)) makes the decision and the row.
//
// Pure and import-free. MIRRORED byte for byte below this header at
// mobile/lib/mistakeRaise.ts (tests/unit/mistake-tracking.test.ts) — change this
// file first, then copy everything from the first export down.

export const MISTAKE_CAUSES = [
  { value: "quoting", label: "Quoting" },
  { value: "ordering", label: "Ordering" },
  { value: "supplier", label: "Supplier" },
  { value: "install", label: "Install" },
  { value: "communication_handover", label: "Communication / handover" },
  { value: "plans_builder_change", label: "Plans / builder change" },
  { value: "site_conditions", label: "Site conditions" },
  { value: "other", label: "Other" },
] as const;

export type MistakeCause = (typeof MISTAKE_CAUSES)[number]["value"];

export const MISTAKE_STATUSES = [
  { value: "open", label: "Open" },
  { value: "costed", label: "Costed" },
  { value: "closed", label: "Closed" },
] as const;

export type MistakeStatus = (typeof MISTAKE_STATUSES)[number]["value"];

export const MISTAKE_DESCRIPTION_MAX = 2000;
export const MAX_REWORK_ENTRIES = 50;
export const MAX_MISTAKE_PHOTOS = 8;

export function isMistakeCause(v: unknown): v is MistakeCause {
  return typeof v === "string" && MISTAKE_CAUSES.some((c) => c.value === v);
}

export function causeLabel(v: string | null | undefined): string | null {
  return MISTAKE_CAUSES.find((c) => c.value === v)?.label ?? null;
}

export function mistakeStatusLabel(v: string | null | undefined): string {
  return MISTAKE_STATUSES.find((s) => s.value === v)?.label ?? "Open";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface RaiseMistakeForm {
  categoryId: string;
  /** "" = not said. */
  causeCode: string;
  /** The job's PO line (stage); "" = not tagged. */
  costCenterId: string;
  description: string;
  /** YYYY-MM-DD; "" = today. */
  occurredOn: string;
  /** The caller's own work time entries on the job, marked as rework. */
  timeEntryIds: string[];
}

export interface RaiseMistakeBody {
  /** The client's id for the mistake — a retry returns the same mistake. */
  id: string;
  categoryId: string;
  causeCode: MistakeCause | null;
  costCenterId: string | null;
  description: string;
  occurredOn: string | null;
  timeEntryIds: string[];
}

export function emptyRaiseForm(): RaiseMistakeForm {
  return { categoryId: "", causeCode: "", costCenterId: "", description: "", occurredOn: "", timeEntryIds: [] };
}

/** The form → the request, or the first problem as a sentence. `today` is the Melbourne day (YYYY-MM-DD). */
export function buildRaiseBody(id: string, form: RaiseMistakeForm, today: string): { ok: true; body: RaiseMistakeBody } | { ok: false; error: string } {
  if (!form.categoryId) return { ok: false, error: "Pick what kind of mistake it was." };
  const description = form.description.trim();
  if (!description) return { ok: false, error: "Say what went wrong." };
  if (description.length > MISTAKE_DESCRIPTION_MAX) return { ok: false, error: `Keep it under ${MISTAKE_DESCRIPTION_MAX} characters.` };
  if (form.causeCode && !isMistakeCause(form.causeCode)) return { ok: false, error: "Pick a cause from the list." };
  const occurredOn = form.occurredOn.trim();
  if (occurredOn && (!DATE_RE.test(occurredOn) || Number.isNaN(Date.parse(`${occurredOn}T00:00:00Z`)))) {
    return { ok: false, error: "Enter the date it happened." };
  }
  if (occurredOn && occurredOn > today) return { ok: false, error: "The date can't be in the future." };
  const timeEntryIds = [...new Set(form.timeEntryIds)];
  if (timeEntryIds.length > MAX_REWORK_ENTRIES) return { ok: false, error: "Tick fewer time entries." };
  return {
    ok: true,
    body: {
      id,
      categoryId: form.categoryId,
      causeCode: form.causeCode ? (form.causeCode as MistakeCause) : null,
      costCenterId: form.costCenterId || null,
      description,
      occurredOn: occurredOn || null,
      timeEntryIds,
    },
  };
}

/** The route's check of a request body; null = refuse it. */
export function parseRaiseBody(v: unknown): RaiseMistakeBody | null {
  if (!v || typeof v !== "object") return null;
  const b = v as Record<string, unknown>;
  const optUuid = (x: unknown) => x === null || x === undefined || x === "" || (typeof x === "string" && UUID_RE.test(x));
  if (typeof b.id !== "string" || !UUID_RE.test(b.id)) return null;
  if (typeof b.categoryId !== "string" || !UUID_RE.test(b.categoryId)) return null;
  if (!optUuid(b.costCenterId)) return null;
  if (!(b.causeCode === null || b.causeCode === undefined || b.causeCode === "" || isMistakeCause(b.causeCode))) return null;
  if (typeof b.description !== "string") return null;
  const description = b.description.trim();
  if (!description || description.length > MISTAKE_DESCRIPTION_MAX) return null;
  if (!(b.occurredOn === null || b.occurredOn === undefined || b.occurredOn === "" || (typeof b.occurredOn === "string" && DATE_RE.test(b.occurredOn)))) return null;
  const ids = b.timeEntryIds ?? [];
  if (!Array.isArray(ids) || ids.length > MAX_REWORK_ENTRIES || !ids.every((x) => typeof x === "string" && UUID_RE.test(x))) return null;
  return {
    id: b.id,
    categoryId: b.categoryId,
    causeCode: b.causeCode ? (b.causeCode as MistakeCause) : null,
    costCenterId: typeof b.costCenterId === "string" && b.costCenterId ? b.costCenterId : null,
    description,
    occurredOn: typeof b.occurredOn === "string" && b.occurredOn ? b.occurredOn : null,
    timeEntryIds: [...new Set(ids as string[])],
  };
}

export const MISTAKE_SENTENCES = {
  badRequest: "Something was missing from the request. Try again.",
  notSwitchedOn: "Logging mistakes isn't switched on yet — tell the office.",
  notAllowed: "Your account can't log mistakes.",
  notFound: "Job not found.",
  notYours: "This job isn't one of yours.",
  conflict: "That mistake isn't yours. Close it and try again.",
  category: "Pick what kind of mistake it was.",
  cause: "Pick a cause from the list.",
  description: "Say what went wrong (up to 2000 characters).",
  future: "The date can't be in the future.",
  stage: "Pick one of this job's cost centres.",
  ownTime: "You can only mark your own time on this job as rework.",
  timeTaken: "Some of that time is already part of another mistake.",
  failed: "Couldn't log the mistake. Try again.",
  loadFailed: "Couldn't load this job's mistakes. Try again.",
  photoNotFound: "That mistake isn't on this job any more.",
  photoPath: "That photo isn't stored with this mistake.",
  photoLimit: `A mistake can have up to ${MAX_MISTAKE_PHOTOS} photos.`,
  photoFailed: "The photo didn't upload. Check the connection and try again.",
} as const;

/**
 * The answer for an error from raise_job_mistake() / add_job_mistake_photo().
 * Their own codes (MJ120–MJ134) map to fixed sentences; anything else is a
 * 500 — the database's text never reaches the caller.
 */
export function mistakeRpcError(error: { code?: string | null } | null | undefined): { status: number; error: string } {
  switch (error?.code) {
    case "42883":
    case "PGRST202":
    case "42P01":
    case "PGRST205":
      return { status: 409, error: MISTAKE_SENTENCES.notSwitchedOn };
    case "MJ120":
      return { status: 400, error: MISTAKE_SENTENCES.badRequest };
    case "MJ121":
      return { status: 403, error: MISTAKE_SENTENCES.notAllowed };
    case "MJ122":
      return { status: 404, error: MISTAKE_SENTENCES.notFound };
    case "MJ123":
      return { status: 403, error: MISTAKE_SENTENCES.notYours };
    case "MJ124":
      return { status: 409, error: MISTAKE_SENTENCES.conflict };
    case "MJ125":
      return { status: 400, error: MISTAKE_SENTENCES.category };
    case "MJ126":
      return { status: 400, error: MISTAKE_SENTENCES.cause };
    case "MJ127":
      return { status: 400, error: MISTAKE_SENTENCES.description };
    case "MJ128":
      return { status: 400, error: MISTAKE_SENTENCES.future };
    case "MJ129":
      return { status: 400, error: MISTAKE_SENTENCES.stage };
    case "MJ130":
      return { status: 400, error: MISTAKE_SENTENCES.ownTime };
    case "MJ131":
      return { status: 409, error: MISTAKE_SENTENCES.timeTaken };
    case "MJ132":
      return { status: 404, error: MISTAKE_SENTENCES.photoNotFound };
    case "MJ133":
      return { status: 400, error: MISTAKE_SENTENCES.photoPath };
    case "MJ134":
      return { status: 409, error: MISTAKE_SENTENCES.photoLimit };
    default:
      return { status: 500, error: MISTAKE_SENTENCES.failed };
  }
}

/** Where a mistake's photo is kept (job-photos bucket) — the shape add_job_mistake_photo() accepts. */
export function mistakePhotoPath(jobId: string, mistakeId: string, ext: string, now: number): string {
  return `${jobId}/mistakes/${mistakeId}/${now}.${ext}`;
}

/** A mistake the caller raised, as the route answers it — no money. */
export interface MyMistake {
  id: string;
  occurredOn: string;
  category: string | null;
  causeCode: string | null;
  description: string;
  status: string;
  stageId: string | null;
  stageName: string | null;
  raisedAt: string | null;
  photoCount: number;
  reworkEntryIds: string[];
}

/** "Install error (rework) · Drainage · 3 Nov" — for the crew's list. */
export function myMistakeSummary(m: Pick<MyMistake, "category" | "stageName">): string {
  return [m.category ?? "Mistake", m.stageName].filter(Boolean).join(" · ");
}
