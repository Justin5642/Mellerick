// What the device mirror is GUARANTEED to hold, and the checks local reads use
// to stay inside it.
//
// Migration 0068 (drafted, not applied until the owner runs it) stops
// PowerSync replicating all of history: rows leave a device once they are
// closed and older than a window (office: 24 months; technician jobs: 90 days;
// backflow tests: 24 months plus each device's latest pass). Before that, a
// local read could treat "not in SQLite" as "does not exist". After it, an
// all-history query run locally returns a silently truncated answer — a
// customer's job history missing its first years, a revenue report missing old
// invoices — and presents it as complete.
//
// So the server publishes, in the synced `sync_horizon` row, the exact cutoffs
// it computed the window flags against, in the same transaction as the flags.
// Every row whose window timestamp is >= the cutoff is on the device (invariant
// O2 in 0068's header). A read that can prove its request is inside that range
// answers locally; anything else throws OutsideSyncWindow, which fromLocalOr
// routes to Supabase under reason "out-of-window".
//
// WHY THE SERVER'S CUTOFF AND NOT `Date.now() - 24 months`: the phone's clock
// lies (HANDOVER §3). Comparing two server-written values — a row's timestamp
// and the cutoff — needs no device clock at all.
//
// NO ROW = NO WINDOW. The horizon row is written by the same migration that
// introduces the flags, and synced by the same stream file that filters on
// them. If it is absent, either the migration or the stream file is not
// deployed — and in both cases the device still receives every row, so local
// reads remain complete, exactly as before.
import { OutsideSyncWindow, type LocalReads } from "./source";

export type WindowScope = "office" | "tech" | "backflow";

export const SQL_SYNC_HORIZON = `
  SELECT tech_cutoff, office_cutoff, backflow_cutoff FROM sync_horizon WHERE id = 'current'`;

/** Present on the device iff the job is in this device's window. */
export const SQL_JOB_ON_DEVICE = `SELECT id FROM jobs WHERE id = ?`;

type RawHorizon = Record<`${WindowScope}_cutoff`, string | null>;

const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/**
 * Epoch milliseconds of a Postgres date / timestamptz as PowerSync or
 * PostgREST renders it ("2024-10-09 03:17:00.123456Z",
 * "2024-10-09T03:17:00+00:00", "2024-10-09"), or NaN.
 *
 * Parsed by hand rather than with Date.parse: engines disagree on the
 * space-separated form and on more than three fractional digits, and a
 * misparse here would be read as "inside the window".
 */
export function timestampMs(text: string | null | undefined): number {
  if (typeof text !== "string") return NaN;
  const m = TIMESTAMP.exec(text.trim());
  if (!m) return NaN;
  const [, y, mo, d, hh = "0", mi = "0", ss = "0", frac = "", zone] = m;
  const ms = Number((frac + "000").slice(0, 3));
  let t = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi), Number(ss), ms);
  if (zone && zone.toUpperCase() !== "Z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    const offsetMin = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || "0");
    t -= sign * offsetMin * 60_000;
  }
  return t;
}

/**
 * The cutoff (epoch ms) for `scope`, or null when no window is in force.
 *
 * The key check is deliberate: a row that does not carry the column is not a
 * horizon row (the London-school fakes answer every getOptional with the same
 * row), and must not be mistaken for one. A horizon row whose cutoff cannot be
 * read is the opposite case — a window IS in force and its extent is unknown —
 * so it sends the read to the network.
 */
export async function windowCutoff(db: LocalReads, scope: WindowScope): Promise<number | null> {
  const row = await db.getOptional<RawHorizon>(SQL_SYNC_HORIZON);
  const key = `${scope}_cutoff` as const;
  if (!row || typeof row !== "object" || !(key in row)) return null;
  const cutoff = timestampMs(row[key]);
  if (Number.isNaN(cutoff)) throw new OutsideSyncWindow(`unreadable ${key} ${String(row[key])}`);
  return cutoff;
}

/**
 * For reads over ALL history (reports, a customer's complete record, an
 * equipment item's full log): only answerable locally when no window is in
 * force.
 */
export async function requireNoWindow(db: LocalReads, scope: WindowScope, what: string): Promise<void> {
  const cutoff = await windowCutoff(db, scope);
  if (cutoff !== null) throw new OutsideSyncWindow(`${what} spans all history`);
}

/**
 * For reads bounded below by a window timestamp (`date >= since`): local only
 * when `since` is not older than the cutoff.
 */
export async function requireCoveredSince(
  db: LocalReads,
  scope: WindowScope,
  since: string,
  what: string
): Promise<void> {
  const cutoff = await windowCutoff(db, scope);
  if (cutoff === null) return;
  const t = timestampMs(since);
  if (Number.isNaN(t) || t < cutoff) throw new OutsideSyncWindow(`${what} from ${since}`);
}

/**
 * For newest-first pages ordered by `created_at` (with the filter, if any,
 * applied identically locally and remotely).
 *
 * The page is complete iff it is FULL and its OLDEST row is inside the window:
 * every row the server would rank above that one has an equal or newer
 * created_at, hence is inside the window, hence is on the device — so the local
 * OFFSET counted exactly the rows the server's would. A short page proves
 * nothing: the server may hold older matches the device dropped.
 */
export async function requireCompletePage(
  db: LocalReads,
  scope: WindowScope,
  rows: { created_at: string | null }[],
  limit: number,
  what: string
): Promise<void> {
  const cutoff = await windowCutoff(db, scope);
  if (cutoff === null) return;
  if (rows.length < limit) throw new OutsideSyncWindow(`${what}: short page`);
  const oldest = timestampMs(rows[rows.length - 1].created_at);
  if (Number.isNaN(oldest) || oldest < cutoff) throw new OutsideSyncWindow(`${what}: page reaches past the window`);
}

/**
 * For reads of ONE job's children (billing lines, variations, equipment).
 * Children travel with their job (invariant O1 of draft migration 0068), so a job on the device
 * means all of its children are; a job that is not means it fell out of the
 * window and its children may be partial. Only checked when a window is in
 * force — without one an absent job is genuinely absent, as before.
 */
export async function requireJobOnDevice(db: LocalReads, scope: WindowScope, jobId: string): Promise<void> {
  const cutoff = await windowCutoff(db, scope);
  if (cutoff === null) return;
  const job = await db.getOptional<{ id: string }>(SQL_JOB_ON_DEVICE, [jobId]);
  if (!job || job.id !== jobId) throw new OutsideSyncWindow(`job ${jobId} is not on this device`);
}
