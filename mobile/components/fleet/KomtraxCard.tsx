import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { openExternalUrl } from "../../lib/open-external-url";
import { komtraxMapsUrl, type KomtraxForMachine } from "../../lib/fleetOffice";

// Fleet → machine → Komtrax on the phone (office/admin; the web's
// components/fleet/equipment-komtrax.tsx). Engine hours, last known position,
// fuel used and the last 30 days' fault codes, as Komatsu last reported them
// (about every 6 hours). Online, read-only, no money.

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : null;
const one = (n: number) => (Math.round(n * 10) / 10).toLocaleString("en-AU");
const litres = (n: number | null, u: string | null) => (n == null ? "—" : `${one(n)} ${!u || u.toLowerCase().startsWith("lit") ? "L" : u}`);

export function KomtraxCard({ data, error }: { data: KomtraxForMachine | null; error: string | null }) {
  if (error) return <Text style={styles.muted}>Komtrax: {error}</Text>;
  if (!data) return null;
  if (!data.connected) return <Text style={styles.muted}>Komtrax not connected.</Text>;
  if (!data.ready || !data.machine) return null;
  const m = data.machine;
  const mapUrl = m.lat != null && m.lng != null ? komtraxMapsUrl(m.lat, m.lng) : null;
  return (
    <>
      <Text style={styles.section}>Komtrax · {m.model}</Text>
      <View style={styles.card}>
        <Row label="Engine hours" value={m.hours == null ? "—" : `${one(m.hours)} h`} sub={when(m.hours_at)} />
        {m.idle_hours != null && <Row label="Idle hours" value={`${one(m.idle_hours)} h`} />}
        <Row label="Fuel used, last 24 h" value={litres(m.fuel_used_last24, m.fuel_units)} sub={`${litres(m.fuel_used_cumulative, m.fuel_units)} lifetime`} />
        {m.fuel_remaining_pct != null && (
          <Row label="Tank" value={`${Math.round(m.fuel_remaining_pct)}%`} sub={m.def_remaining_pct != null ? `DEF ${Math.round(m.def_remaining_pct)}%` : null} />
        )}
        {mapUrl ? (
          <TouchableOpacity
            style={styles.mapBtn}
            onPress={() => void openExternalUrl(mapUrl, "the map")}
            accessibilityRole="button"
            accessibilityLabel="Open last known location in maps"
          >
            <Ionicons name="location-outline" size={16} color={colors.blue600} />
            <Text style={styles.mapText}>Last known location{m.location_at ? ` · ${when(m.location_at)}` : ""}</Text>
          </TouchableOpacity>
        ) : (
          <Text style={styles.muted}>No location reported.</Text>
        )}
        <Text style={styles.subhead}>Fault codes, last 30 days</Text>
        {data.faults.length === 0 ? (
          <Text style={styles.muted}>None reported.</Text>
        ) : (
          data.faults.map((f) => (
            <View key={f.id} style={styles.fault}>
              <Text style={styles.code}>{f.code}{f.severity ? ` · ${f.severity}` : ""}</Text>
              <Text style={styles.desc}>{f.description ?? "No description"}</Text>
              <Text style={styles.muted}>{when(f.occurred_at)}</Text>
            </View>
          ))
        )}
      </View>
    </>
  );
}

function Row({ label, value, sub }: { label: string; value: string; sub?: string | null }) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <View style={{ alignItems: "flex-end" }}>
        <Text style={styles.value}>{value}</Text>
        {sub ? <Text style={styles.muted}>{sub}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginTop: 16, marginBottom: 8, marginLeft: 4 },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12, gap: 8 },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  label: { fontSize: 14, color: colors.slate500 },
  value: { fontSize: 14, fontWeight: "600", color: colors.slate900 },
  muted: { fontSize: 12, color: colors.slate500 },
  subhead: { fontSize: 12, fontWeight: "700", color: colors.slate500, marginTop: 4 },
  mapBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4 },
  mapText: { fontSize: 14, color: colors.blue600, fontWeight: "600" },
  fault: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 6 },
  code: { fontSize: 13, fontWeight: "700", color: colors.slate900 },
  desc: { fontSize: 13, color: colors.slate700 },
});
