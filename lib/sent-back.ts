// A job the office sent back to the crew (Approvals → "Send back"; 0122).
//
// The office sets jobs.admin_status = 'rejected' with a note; 0122's trigger
// copies the note to jobs.sent_back_note and stamps sent_back_at, and pushes
// the crew. The job page shows a red banner and My Jobs a "Sent back" tag
// while the job is still sent back and open. Signing it off again puts it back
// to 'pending' (0098), which clears both.
//
// The note is sent_back_note, never admin_notes on the phone: admin_notes also
// holds the admin's approval comment, which can talk money. Before 0122 the
// web (which reads the whole jobs row for crew and office) falls back to
// admin_notes while the job is sent back — at that moment it IS the send-back
// note. The phone never has admin_notes.
//
// Mirrored byte for byte from the first export at mobile/lib/sentBack.ts
// (tests/unit/sent-back.test.ts) — change this file first, then copy.

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
