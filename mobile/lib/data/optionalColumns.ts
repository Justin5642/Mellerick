// Columns a queued write may carry before the migration that adds them is
// applied. Today: job_bookings.note (0109 — the booking's scheduling note),
// and customers.billing_address (0114 — applied 2026-11-21; kept for a
// database without it, where a customer keeps every other field and only
// loses the address), and job_photos.folder (0116, draft — a queued photo
// keeps everything else and lands under "Other"; a queued folder move has
// nothing left to write and is done).
//
// Why the gateway needs this: a write sitting in the outbox is replayed as it
// was queued. If the phone ships before 0109 is applied, an insert or edit
// carrying `note` is refused by PostgREST (PGRST204, "column not in the schema
// cache" — or 42703 from Postgres) on EVERY attempt, which is a rejection, so
// it would dead-letter and lose the booking itself, not just its note. So when
// the server names one of these columns as missing, the write is retried once
// without it. The note is not lost outright: the schedule sheet also posts it
// to the job's Notes (job_notes, source 'schedule').
//
// Matched on the error code AND the column's name, so a different missing
// column (real drift) still fails loudly.
export const OPTIONAL_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  job_bookings: ["note"],
  customers: ["billing_address"],
  job_photos: ["folder"],
};

/**
 * The payload without the optional column(s) the error says are missing, or
 * null when this error is not about one (the caller then throws as before).
 */
export function withoutMissingOptionalColumns(
  table: string,
  payload: Record<string, unknown>,
  error: { code?: string; message?: string } | null | undefined
): Record<string, unknown> | null {
  if (!error || (error.code !== "PGRST204" && error.code !== "42703")) return null;
  const message = error.message ?? "";
  const missing = (OPTIONAL_COLUMNS[table] ?? []).filter(
    (col) => col in payload && new RegExp(`\\b${col}\\b`).test(message)
  );
  if (missing.length === 0) return null;
  const rest = { ...payload };
  for (const col of missing) delete rest[col];
  return rest;
}
