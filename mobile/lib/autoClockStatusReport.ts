import { Platform } from "react-native";
import Constants from "expo-constants";
import { supabase } from "./supabase";

// Tells the office whether this phone's automatic clock in/out can actually
// work (migration 0102; shown on the web Staff page).
//
// Auto clock bug, 15 Nov 2026: sites that were being watched never fired and
// clock-outs went missing, and nobody could see why — the phone knew ("Always"
// location declined, Approximate location, nothing to watch) but only said so
// on the phone. This sends that status when it changes, and at most every few
// hours otherwise so the office can tell a quiet phone from a dead one.
//
// Best-effort by design: a report that fails (offline, or the table not there
// yet) is dropped and simply tried again on the next change. It must never get
// in the way of the clocking itself, so it is NOT queued in the outbox.

export interface AutoClockReport {
  tracking: boolean;
  reason: "declined" | "no-sites" | "off-hours" | "not-technician" | "signed-out" | "failed" | null;
  backgroundOff: boolean;
  approximate: boolean;
  siteCount: number;
}

/** Re-send an unchanged status this often, so "last seen" stays meaningful. */
export const REPORT_HEARTBEAT_MS = 6 * 60 * 60 * 1000;

const key = (r: AutoClockReport) => [r.tracking, r.reason, r.backgroundOff, r.approximate, r.siteCount].join("|");

/** Whether `next` is worth sending, given what was last sent and when. */
export function shouldReport(last: { report: AutoClockReport; atMs: number } | null, next: AutoClockReport, nowMs: number): boolean {
  if (next.reason === "signed-out") return false;
  if (!last) return true;
  if (key(last.report) !== key(next)) return true;
  return nowMs - last.atMs >= REPORT_HEARTBEAT_MS;
}

export function appVersionLabel(): string | null {
  const version = Constants.expoConfig?.version ?? null;
  const build = Platform.OS === "ios" ? Constants.expoConfig?.ios?.buildNumber : Constants.expoConfig?.android?.versionCode;
  return version ? (build ? `${version} (${build})` : version) : null;
}

export async function sendAutoClockReport(staffId: string, r: AutoClockReport): Promise<boolean> {
  const { error } = await supabase.from("auto_clock_status").upsert(
    {
      staff_id: staffId,
      tracking: r.tracking,
      reason: r.tracking ? null : r.reason,
      background_off: r.backgroundOff,
      approximate: r.approximate,
      site_count: Math.max(0, Math.round(r.siteCount)),
      platform: Platform.OS,
      app_version: appVersionLabel(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "staff_id" }
  );
  if (error && __DEV__) console.warn("[auto-clock] status report not sent:", error.message);
  return !error;
}
