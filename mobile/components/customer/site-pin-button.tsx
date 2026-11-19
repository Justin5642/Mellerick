import { useState } from "react";
import { Alert, StyleSheet, Text, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Location from "expo-location";
import { colors } from "../../lib/theme";
import { RoleGate } from "../../design/guards/RoleGate";
import { useCustomers } from "../../lib/data/hooks/useCustomers";
import { openExternalUrl } from "../../lib/open-external-url";
import { formatPin, geocodeSiteAddress, pinFixProblem, siteAddress, type SiteAddressParts } from "../../lib/officeActions";

// "Set pin" on a site (office/admin) — the phone's version of the web's
// SitePinButton / SiteLocationDialog. The binary has no map module
// (react-native-maps isn't in it, and none is added), so instead of dragging a
// pin the office can:
//   • Look up the address — the server's geocoder, house/building matches only
//     (a street or suburb guess would put the auto clock-in fence in the wrong
//     place), online;
//   • Use where I am now — standing on site, a fix within ±50 m (the crew's
//     "Set site location here" rule);
//   • View on map — opens the saved pin in the phone's maps app to check it.
// Either way it asks before saving, and saves the two coordinates through the
// outbox (CustomersRepository.setSitePin), so a pin set with no signal still
// lands.

export interface PinnableSite extends SiteAddressParts {
  id: string;
  name?: string | null;
  site_lat?: number | null;
  site_lng?: number | null;
}

export function SitePinButton({ site, onSaved }: { site: PinnableSite; onSaved: (lat: number, lng: number) => void }) {
  return (
    <RoleGate roles={["office", "admin"]}>
      <SitePinButtonInner site={site} onSaved={onSaved} />
    </RoleGate>
  );
}

function SitePinButtonInner({ site, onSaved }: { site: PinnableSite; onSaved: (lat: number, lng: number) => void }) {
  const writes = useCustomers();
  const [busy, setBusy] = useState<string | null>(null);
  const located = site.site_lat != null && site.site_lng != null;

  function askToSave(lat: number, lng: number, where: string) {
    Alert.alert(
      located ? "Move the site's pin?" : "Save the site's pin?",
      `${where}\n${formatPin(lat, lng)}\n\nAuto clock-in triggers within 150 m of this point.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Save pin",
          onPress: async () => {
            if (!writes.ready) {
              Alert.alert("Not ready yet", "The app is still starting up. Try again in a moment.");
              return;
            }
            try {
              const { synced } = await writes.setSitePin(site.id, lat, lng);
              onSaved(lat, lng);
              if (!synced) Alert.alert("Saved on this phone", "The pin reaches the office when the phone is back online.");
            } catch (e) {
              Alert.alert("Couldn't save the pin", e instanceof Error ? e.message : "Please try again.");
            }
          },
        },
      ]
    );
  }

  async function fromAddress() {
    const address = siteAddress(site);
    if (!address) {
      Alert.alert("No street address", "This site has no street address to look up. Use where you are, or set it on the website's map.");
      return;
    }
    setBusy("Looking up…");
    try {
      const found = await geocodeSiteAddress(address);
      askToSave(found.lat, found.lng, found.display ?? address);
    } catch (e) {
      const why = e instanceof Error ? e.message : "Please try again.";
      Alert.alert("Couldn't place the address", `${why}\n\nNew estate streets often aren't mapped house by house yet — stand on site and use "Where I am now", or drop the pin on the website's map.`);
    } finally {
      setBusy(null);
    }
  }

  async function fromHere() {
    setBusy("Getting your location…");
    try {
      const perm = await Location.getForegroundPermissionsAsync();
      if (perm.status !== "granted") {
        const asked = await Location.requestForegroundPermissionsAsync();
        if (asked.status !== "granted") {
          Alert.alert("Location is off", "Location isn't allowed for this app. Allow it in Settings, then try again.");
          return;
        }
      }
      const position = await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 15_000)),
      ]);
      const fix = position ? { latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy } : null;
      const problem = pinFixProblem(fix);
      if (problem || !fix) {
        Alert.alert("Can't use this location", problem ?? "Couldn't get a fix on where you are.");
        return;
      }
      askToSave(fix.latitude, fix.longitude, `Where you are now (±${Math.round(fix.accuracy ?? 0)} m)`);
    } catch {
      Alert.alert("Can't use this location", "Couldn't get a fix on where you are. Step into the open and try again.");
    } finally {
      setBusy(null);
    }
  }

  function open() {
    const buttons: { text: string; style?: "cancel" | "destructive"; onPress?: () => void }[] = [
      { text: "Look up the address", onPress: () => void fromAddress() },
      { text: "Where I am now", onPress: () => void fromHere() },
    ];
    if (located) {
      buttons.push({
        text: "View on map",
        onPress: () => void openExternalUrl(`https://www.google.com/maps/search/?api=1&query=${site.site_lat},${site.site_lng}`, "the map"),
      });
    }
    buttons.push({ text: "Cancel", style: "cancel" });
    Alert.alert(
      `Map pin — ${site.name ?? site.address_line1 ?? "site"}`,
      located
        ? `Pinned at ${formatPin(site.site_lat as number, site.site_lng as number)}.`
        : "No map location: auto clock-in won't work at this site until it has one.",
      buttons
    );
  }

  return (
    <TouchableOpacity
      style={styles.btn}
      onPress={open}
      disabled={!!busy}
      hitSlop={8}
      accessibilityLabel={located ? "Adjust the site's map pin" : "Set the site's map pin"}
    >
      <Ionicons name="location-outline" size={14} color={located ? colors.slate400 : colors.orange700} />
      <Text style={[styles.text, !located && styles.textMissing]}>{busy ?? (located ? "Pin" : "Set pin")}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: { flexDirection: "row", alignItems: "center", gap: 3, paddingVertical: 4, paddingHorizontal: 6 },
  text: { fontSize: 12, fontWeight: "600", color: colors.slate500 },
  textMissing: { color: colors.orange700 },
});
