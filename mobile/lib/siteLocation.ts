import * as Location from "expo-location";
import { supabase } from "./supabase";
import { fetchWithTimeout } from "./fetchWithTimeout";

// "Set site location here" (clock extras, 31 Oct 2026; web route
// /api/jobs/[id]/site-location). Standing on site, the tech pins the job's site
// where they are so the auto-clock fence is right. Needs a good fix (the
// server refuses worse than ±50 m) and signal.

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;

export async function setSiteLocationHere(jobId: string): Promise<void> {
  const perm = await Location.getForegroundPermissionsAsync();
  if (perm.status !== "granted") {
    const asked = await Location.requestForegroundPermissionsAsync();
    if (asked.status !== "granted") throw new Error("Location isn't allowed for this app. Allow it in Settings, then try again.");
  }
  const position = await Promise.race([
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
  ]);
  if (!position) throw new Error("Couldn't get a fix on where you are. Step into the open and try again.");

  if (!API_BASE_URL) throw new Error("App isn't configured to reach the office server.");
  const { data: sessionData } = await supabase.auth.getSession();
  const accessToken = sessionData.session?.access_token;
  if (!accessToken) throw new Error("Your session has expired. Sign out and back in, then try again.");
  let res: Response;
  try {
    res = await fetchWithTimeout(`${API_BASE_URL}/api/jobs/${jobId}/site-location`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ lat: position.coords.latitude, lng: position.coords.longitude, accuracy: position.coords.accuracy }),
    });
  } catch {
    throw new Error("No connection. Try again when you have signal.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Server returned ${res.status}. Try again.`);
}
