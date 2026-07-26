import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { getWaterAuthorityLabel, DUE_STATUS_LABELS, DUE_STATUS_COLORS } from "../../lib/backflow";
import type { BackflowRow } from "../../lib/data/reads/backflow";

function formatDate(d: Date) {
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

// Shared backflow-device card used by both the technician tab and the
// office/admin list, so the two never diverge.
export function BackflowDeviceRow({ row, onPress }: { row: BackflowRow; onPress?: () => void }) {
  const { device, nextDueDate, status } = row;
  const sc = DUE_STATUS_COLORS[status];
  return (
    <TouchableOpacity style={styles.card} onPress={onPress} accessibilityLabel={`Backflow device for ${device.customers?.name ?? "unknown customer"}`}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle} numberOfLines={1}>{device.customers?.name ?? "Unknown customer"}</Text>
        <View style={[styles.badge, { backgroundColor: sc.bg }]}>
          <Text style={[styles.badgeText, { color: sc.text }]}>{DUE_STATUS_LABELS[status]}</Text>
        </View>
      </View>
      <View style={styles.cardMetaRow}>
        {device.sites?.suburb && (
          <Text style={styles.cardMeta}>
            <Ionicons name="location-outline" size={12} color={colors.slate400} /> {device.sites.suburb}
          </Text>
        )}
        <Text style={styles.cardMeta}>{getWaterAuthorityLabel(device.water_authority)}</Text>
        {device.serial_number && <Text style={styles.cardMeta}>S/N {device.serial_number}</Text>}
      </View>
      <Text style={styles.cardDue}>{nextDueDate ? `Due ${formatDate(nextDueDate)}` : "No passing test yet"}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: 12, padding: 14, marginBottom: 10, borderWidth: 1, borderColor: colors.border },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  cardTitle: { fontSize: 15, fontWeight: "600", color: colors.slate900, flex: 1 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  badgeText: { fontSize: 11, fontWeight: "600" },
  cardMetaRow: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 6 },
  cardMeta: { fontSize: 12, color: colors.slate500 },
  cardDue: { fontSize: 12, color: colors.slate400, marginTop: 4 },
});
