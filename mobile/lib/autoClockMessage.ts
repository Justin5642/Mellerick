import type { TrackingStatus } from "./location-tracking";

// What the phone tells the tech about the automatic clock (clock extras, 31 Oct
// 2026). Before this nothing on screen said whether it was running, so a tech
// whose phone had "Always" or Precise location turned off had no way to know
// their arrivals weren't being recorded.

export interface AutoClockMessage {
  tone: "ok" | "warn" | "off";
  text: string;
  /** Show a button to the phone's Settings — the fix is a setting there. */
  settings: boolean;
}

export function autoClockMessage(s: TrackingStatus): AutoClockMessage | null {
  if (s.enabled && s.approximate) {
    return { tone: "warn", text: "Location is set to Approximate, so auto clock can't tell if you're on site. Turn on Precise Location.", settings: true };
  }
  if (s.enabled && s.backgroundOff) {
    return { tone: "warn", text: "Auto clock only works while the app is open. Set location to \"Always\" so it works in your pocket.", settings: true };
  }
  if (s.enabled) return { tone: "ok", text: "Auto clock is on.", settings: false };
  switch (s.reason) {
    case "declined":
      return { tone: "off", text: "Auto clock is off (location wasn't allowed). Clock on and off by hand.", settings: true };
    case "no-sites":
      return { tone: "off", text: "Auto clock has no site to watch: none of your jobs has a site location. Use \"Set site location here\" on the job.", settings: false };
    case "off-hours":
      return { tone: "off", text: "Auto clock sleeps outside work hours. Clock on by hand if you're working.", settings: false };
    case "failed":
      return { tone: "off", text: "Auto clock couldn't start. Clock on and off by hand.", settings: true };
    default:
      return null; // office/admin, signed out, or not decided yet
  }
}
