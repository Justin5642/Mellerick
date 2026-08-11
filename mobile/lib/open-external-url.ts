import { Alert, Linking } from "react-native";

// Opening a link is a promise, and every call site in this app was discarding
// it (item N3, 8 of the 75 floating promises).
//
// WHAT THAT COSTS. `Linking.openURL` REJECTS when the platform has no handler
// for the URL — no Waze installed, a `tel:` link on a tablet with no dialler, a
// signed storage URL the browser refuses. Discarded, the rejection produces
// nothing at all: the technician taps "Waze", the screen does not move, and
// there is no way to tell that from a slow tap. They tap again. It is the same
// silence as a write that reports success while doing nothing, except the user
// is standing in a driveway trying to find the site.
//
// `void` would not have fixed it either — it would have converted a dropped
// promise into an unhandled rejection and still shown the user nothing.
//
// Returns whether the link opened, so a caller that wants to fall back (a map
// app, then a browser) can, and so tests assert on the outcome rather than on
// Linking having been called.
export async function openExternalUrl(url: string, what = "this link"): Promise<boolean> {
  try {
    await Linking.openURL(url);
    return true;
  } catch (e) {
    // Deliberately NOT swallowed and logged. A log line in a release build on a
    // technician's phone is not reachable by anyone; the person holding the
    // phone is the only one who can act on this.
    Alert.alert(
      "Couldn't open that",
      `Nothing on this device could open ${what}. ${
        e instanceof Error && e.message ? e.message : ""
      }`.trim()
    );
    return false;
  }
}

/**
 * Open a navigation app for a site, falling back from coordinates to a text
 * search, and telling the user if neither works.
 *
 * The fallback exists because the two URLs fail for different reasons: the
 * coordinate form needs a handler for waze.com links, the query form needs the
 * address to be resolvable. Trying the second after the first fails is the
 * behaviour a person would expect and none of the call sites had.
 */
export async function openNavigation(
  site: { site_lat?: number | null; site_lng?: number | null; address_line1?: string | null; suburb?: string | null; state?: string | null } | null | undefined
): Promise<boolean> {
  if (!site) return false;

  if (site.site_lat != null && site.site_lng != null) {
    if (await openExternalUrl(`https://waze.com/ul?ll=${site.site_lat},${site.site_lng}&navigate=yes`, "navigation")) {
      return true;
    }
  }

  const parts = [site.address_line1, site.suburb, site.state].filter(Boolean).join(" ");
  if (!parts.trim()) return false;
  return openExternalUrl(`https://waze.com/ul?q=${encodeURIComponent(parts)}&navigate=yes`, "navigation");
}
