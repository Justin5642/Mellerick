import { Alert } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { supabase } from "./supabase";
import { postSiteLocation } from "./siteLocation";
import type { ClockFix } from "./clockFix";
import { SITE_PIN_MAX_ACCURACY_M } from "./dwellPrompt";

// "This site has no map location — save where you are now?" (Justin's
// notebook list, 20 Nov 2026). Auto clock-on needs the site's pin
// (sites.site_lat / site_lng), and new estate streets often can't be found
// by the geocoder. A technician who clocks on BY HAND at such a site is
// almost always standing on it — so the phone offers, once per job, to save
// that fix as the site's location (the existing "Set site location here"
// route, /api/jobs/[id]/site-location: ±50 m, caller on the job or office).
//
// Never silent (always asks), never when the site already has a pin, never
// with a fix worse than ±50 m or with no accuracy, and not again for a job
// once asked (Yes or No) on this phone. Online only: the site is read from
// Supabase and the pin saved through the route; offline it simply doesn't ask.

/** The server's own limit (MAX_PIN_ACCURACY_METRES in the route). Defined beside the clock prompts, which pin too. */
export { SITE_PIN_MAX_ACCURACY_M };
const ASKED_KEY = "sitePinOffer:asked:";

export interface SitePinOfferInput {
  /** The job has a site at all. */
  hasSite: boolean;
  siteLat: number | null | undefined;
  siteLng: number | null | undefined;
  fix: ClockFix | null | undefined;
  /** Already asked for this job on this phone. */
  alreadyAsked: boolean;
}

/** Whether to ask. Pure — tested. */
export function shouldOfferSitePin(i: SitePinOfferInput): boolean {
  if (!i.hasSite || i.alreadyAsked || !i.fix) return false;
  if (i.siteLat != null && i.siteLng != null) return false;
  return i.fix.accuracy != null && i.fix.accuracy <= SITE_PIN_MAX_ACCURACY_M;
}

async function alreadyAsked(jobId: string): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(ASKED_KEY + jobId)) === "1";
  } catch {
    return false;
  }
}

async function markAsked(jobId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(ASKED_KEY + jobId, "1");
  } catch {
    // Best effort: at worst it asks again next time.
  }
}

/**
 * After a manual clock-on: ask whether to save `fix` as the site's location
 * when the site has none. Fire and forget — never throws, never delays the
 * clock-on (call it with `void`).
 */
export async function offerSitePinAfterClockOn(jobId: string, fix: ClockFix | null): Promise<void> {
  try {
    if (!fix || (await alreadyAsked(jobId))) return;
    const { data, error } = await supabase.from("jobs").select("site_id, sites(site_lat, site_lng)").eq("id", jobId).maybeSingle();
    if (error || !data) return;
    const row = data as unknown as { site_id: string | null; sites: { site_lat: number | null; site_lng: number | null } | null };
    const ask = shouldOfferSitePin({
      hasSite: !!row.site_id && !!row.sites,
      siteLat: row.sites?.site_lat,
      siteLng: row.sites?.site_lng,
      fix,
      alreadyAsked: false,
    });
    if (!ask) return;
    await markAsked(jobId);
    Alert.alert(
      "Save the site's location?",
      "This site has no map location — save where you are now as the site's location? (Auto clock-on will then work here.)",
      [
        { text: "Not now", style: "cancel" },
        {
          text: "Save location",
          onPress: () => {
            postSiteLocation(jobId, fix)
              .then(() => Alert.alert("Site location saved", "Auto clock-on will work at this site from now on."))
              .catch((e) => Alert.alert("Couldn't save the location", e instanceof Error ? e.message : "Try again from the job's Overview."));
          },
        },
      ]
    );
  } catch {
    // An offer, nothing more: a failure here must never touch the clock-on.
  }
}
