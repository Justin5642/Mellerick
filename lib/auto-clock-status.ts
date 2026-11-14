// What a phone's auto clock status (migration 0102 — draft, not applied yet)
// means, in words the office can act on. Shown on the Staff page next to each
// person's Auto clock switch.

export interface AutoClockStatusRow {
  staff_id: string;
  tracking: boolean;
  reason: string | null;
  background_off: boolean;
  approximate: boolean;
  site_count: number;
  platform: string | null;
  app_version: string | null;
  updated_at: string;
}

export type StatusTone = "ok" | "warn" | "bad" | "idle";

export interface StatusLabel {
  tone: StatusTone;
  text: string;
  /** What to do about it, when something should be done. */
  fix: string | null;
}

/** A phone silent this long is probably not running the app (or not signed in). */
export const STALE_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

export function describeAutoClockStatus(row: AutoClockStatusRow | null | undefined, nowMs: number = Date.now()): StatusLabel {
  if (!row) {
    return { tone: "idle", text: "Phone hasn't reported yet", fix: "Needs the latest app build, opened and signed in." };
  }
  const age = nowMs - Date.parse(row.updated_at);
  const stale = Number.isFinite(age) && age > STALE_AFTER_MS;
  const since = stale ? ` (last heard ${Math.floor(age / 86_400_000)} days ago)` : "";

  // Permission problems first: they stop auto clock even when everything else is right.
  if (row.reason === "declined") {
    return { tone: "bad", text: `Location turned down on the phone${since}`, fix: "On their phone: Settings → Mellerick Field → Location → Always, and Precise on." };
  }
  if (row.approximate) {
    return { tone: "bad", text: `Approximate location only${since}`, fix: "On their phone: Settings → Mellerick Field → Location → turn Precise Location on." };
  }
  if (row.background_off) {
    return {
      tone: "warn",
      text: `Location set to "While using"${since}`,
      fix: "Only works with the app open. On their phone: Settings → Mellerick Field → Location → Always.",
    };
  }
  if (row.reason === "failed") {
    return { tone: "bad", text: `Location couldn't start${since}`, fix: "Ask them to restart the phone and open the app." };
  }
  if (row.reason === "no-sites") {
    return { tone: "warn", text: `No job sites to watch${since}`, fix: "None of their open jobs has a map location. Set a pin on the job (Set location on map)." };
  }
  if (row.reason === "not-technician") {
    return { tone: "idle", text: "Auto clock off for this person", fix: null };
  }
  if (stale) {
    return { tone: "warn", text: `Phone quiet${since}`, fix: "They may not be opening the app, or have signed out." };
  }
  if (row.tracking) {
    return { tone: "ok", text: `Working — watching ${row.site_count} site${row.site_count === 1 ? "" : "s"}`, fix: null };
  }
  if (row.reason === "off-hours") {
    return { tone: "ok", text: "Ready (outside work hours)", fix: null };
  }
  return { tone: "idle", text: "Not running", fix: null };
}
