import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";

export interface StatCardProps {
  title: string;
  value: number | string;
  icon: keyof typeof Ionicons.glyphMap;
  /** Background color of the icon chip (hex). */
  iconColor: string;
  onPress?: () => void;
}

// A KPI card: colored icon chip + label + big value. Mirrors the web dashboard's
// StatCard. Pure/presentational, tappable to drill into the related area.
export function StatCard({ title, value, icon, iconColor, onPress }: StatCardProps) {
  return (
    <TouchableOpacity
      style={styles.card}
      onPress={onPress}
      disabled={!onPress}
      activeOpacity={0.7}
      accessibilityRole="button"
      accessibilityLabel={`${title}: ${value}`}
      testID="stat-card"
    >
      <View style={[styles.iconWrap, { backgroundColor: iconColor }]}>
        <Ionicons name={icon} size={22} color="#fff" />
      </View>
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>{title}</Text>
        <Text style={styles.value}>{value}</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 14,
    padding: 16,
    flex: 1,
    minWidth: 150,
  },
  iconWrap: { width: 44, height: 44, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  body: { flex: 1 },
  title: { fontSize: 12, color: colors.slate500 },
  value: { fontSize: 22, fontWeight: "700", color: colors.slate900, marginTop: 2 },
});
