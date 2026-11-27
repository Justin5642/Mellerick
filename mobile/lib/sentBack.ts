// Copy of the web's lib/sent-back.ts — see that file for the rule (a job the
// office sent back shows the crew a banner and a tag; 0122). Identical from
// the first export on, pinned by tests/unit/sent-back.test.ts: change the web
// file first, then copy its body here.

export interface SentBackJob {
  status?: string | null;
  admin_status?: string | null;
  sent_back_note?: string | null;
  sent_back_at?: string | null;
  /** Web only, before 0122: the send-back note while the job is sent back. */
  admin_notes?: string | null;
}

export interface SentBackNotice {
  /** What the office asked for; null when they wrote nothing we can show. */
  note: string | null;
  /** When it was sent back (ISO); null before 0122. */
  at: string | null;
}

const CLOSED = new Set(["completed", "cancelled"]);

/** Sent back by the office and still open — show the banner / tag. */
export function isSentBack(job: SentBackJob | null | undefined): boolean {
  if (!job) return false;
  return job.admin_status === "rejected" && !CLOSED.has(job.status ?? "");
}

/** The banner's content, or null when there is nothing to show. */
export function sentBackNotice(job: SentBackJob | null | undefined): SentBackNotice | null {
  if (!job || !isSentBack(job)) return null;
  const note = (job.sent_back_note ?? job.admin_notes ?? "").trim();
  return { note: note === "" ? null : note, at: job.sent_back_at ?? null };
}

/** "Thu 27 Nov, 2:15 pm" in Melbourne time; null when unknown or unreadable. */
export function sentBackWhen(at: string | null | undefined): string | null {
  if (!at) return null;
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  const day = d.toLocaleDateString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "Australia/Melbourne",
  });
  const time = d.toLocaleTimeString("en-AU", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Australia/Melbourne",
  });
  return `${day.replace(",", "")}, ${time.toLowerCase()}`;
}
