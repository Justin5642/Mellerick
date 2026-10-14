import AsyncStorage from "@react-native-async-storage/async-storage";

// Google Play's "prominent disclosure" for background location.
//
// Play policy requires an in-app screen, shown BEFORE the operating system's
// location prompt, that says in plain words what is collected, that it is
// collected while the app is closed, and why. Without it the background
// location declaration is rejected, and the review video has to show it.
//
// Shown only when the tracking gate actually wants location (a technician with
// an open job, in hours or on the clock — lib/trackingGate.ts), and only when
// a permission prompt could follow. "Continue" is remembered on the device;
// "No thanks" only for this app session, so a technician who tapped it by
// mistake is asked again next launch instead of silently never being tracked.

export type DisclosureConsent = "accepted" | "declined";

/** Bumped if the disclosure text changes materially, so everyone sees the new wording once. */
export const DISCLOSURE_STORAGE_KEY = "location-disclosure:v1";

/**
 * Whether the disclosure must be shown before tracking may request permission.
 * Pure — the provider supplies what it read.
 *
 * Not needed when it was already accepted on this device, or when both
 * permissions are already granted (no OS prompt can follow, so there is
 * nothing to disclose ahead of).
 */
export function needsDisclosure(input: {
  acceptedOnDevice: boolean;
  foregroundGranted: boolean;
  backgroundGranted: boolean;
}): boolean {
  if (input.acceptedOnDevice) return false;
  return !(input.foregroundGranted && input.backgroundGranted);
}

export async function readDisclosureAccepted(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(DISCLOSURE_STORAGE_KEY)) === "accepted";
  } catch {
    // Unreadable storage means "not yet accepted": showing the screen again is
    // harmless, skipping it in front of an OS prompt is the policy breach.
    return false;
  }
}

export async function recordDisclosureAccepted(): Promise<void> {
  try {
    await AsyncStorage.setItem(DISCLOSURE_STORAGE_KEY, "accepted");
  } catch (e) {
    console.warn("[geofence] could not remember the location disclosure:", e);
  }
}
