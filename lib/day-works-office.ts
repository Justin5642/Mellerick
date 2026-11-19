// The office's own Day Works / truck-load actions (19 Nov 2026; no migration):
// void a signed Day Works line, void a signed truck load, enter a load's
// docket cost and margin override, and set the job's "Quarry product on this
// job" default. The web tab used to write these straight through the browser's
// Supabase client; they now go through office-only routes so the phone (Bearer
// token) can do the same, and both share one set of rules and words:
//
//   POST /api/jobs/[id]/hire-entries/[entryId]/void
//   POST /api/jobs/[id]/cartage-loads/[loadId]/void
//   PUT  /api/jobs/[id]/cartage-loads/[loadId]/cost
//   PUT  /api/jobs/[id]/cartage-loads/quarry
//
// Every route is requireOfficeOrAdmin and writes with the CALLER's client, so
// RLS and 0108/0111's guard triggers decide exactly as they did for the
// browser's direct writes. These are the pure body checks
// (tests/unit/day-works-office.test.ts).

const MAX_REASON = 500;

/** `{ reason?: string | null }` → the void reason (trimmed; blank = none). */
export function parseVoidBody(body: unknown): { ok: true; reason: string | null } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.reason !== undefined && b.reason !== null && typeof b.reason !== "string") return { ok: false, error: "Say why in words." };
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (reason.length > MAX_REASON) return { ok: false, error: `Keep the reason under ${MAX_REASON} characters.` };
  return { ok: true, reason: reason || null };
}

const num = (v: unknown): number | null | undefined => {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const t = v.trim().replace(",", ".");
    return t === "" ? null : Number(t);
  }
  return undefined;
};

/**
 * `{ docket_cost_ex_gst, margin_pct }` — each a number, a numeric string, blank
 * or null (null margin = the company's). The web form's rule: cost ≥ 0, margin
 * 0–1000 %.
 */
export function parseLoadCostBody(body: unknown): { ok: true; docketCost: number | null; marginPct: number | null } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const c = num(b.docket_cost_ex_gst);
  const m = num(b.margin_pct);
  const bad = (v: number | null | undefined, max: number) => v === undefined || (v !== null && (!Number.isFinite(v) || v < 0 || v > max));
  if (bad(c, 10_000_000) || bad(m, 1000)) return { ok: false, error: "Check the docket cost and margin." };
  const round = (v: number | null, dp: number) => (v === null ? null : Math.round(v * 10 ** dp) / 10 ** dp);
  return { ok: true, docketCost: round(c as number | null, 2), marginPct: round(m as number | null, 2) };
}

/** `{ quarry_included: true | false | null }` (null = the default, included). */
export function parseQuarryBody(body: unknown): { ok: true; quarryIncluded: boolean | null } | { ok: false; error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  if (!("quarry_included" in b)) return { ok: false, error: "Pick included or extra." };
  const v = b.quarry_included;
  if (v === null || v === true || v === false) return { ok: true, quarryIncluded: v };
  return { ok: false, error: "Pick included or extra." };
}

/** The phone's "Quarry product on this job" choice ↔ jobs.quarry_included. */
export type QuarryChoice = "default" | "included" | "extra";
export const quarryChoiceOf = (v: boolean | null | undefined): QuarryChoice => (v === false ? "extra" : v === true ? "included" : "default");
export const quarryValueOf = (c: QuarryChoice): boolean | null => (c === "extra" ? false : c === "included" ? true : null);
