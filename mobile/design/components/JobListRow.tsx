import { ReactNode } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { colors, statusColors } from "../../lib/theme";

// Priority chip colors (theme has no priority map; keep it local + small).
const priorityColors: Record<string, { bg: string; text: string }> = {
  low: { bg: colors.slate100, text: colors.slate500 },
  medium: { bg: colors.blue100, text: colors.blue600 },
  normal: { bg: colors.blue100, text: colors.blue600 },
  high: { bg: colors.orange100, text: colors.orange700 },
  urgent: { bg: colors.red100, text: colors.red600 },
};

function humanize(v: string): string {
  return v.replace(/_/g, " ");
}

export interface JobListRowProps {
  jobNumber: number | string;
  title: string;
  subtitle?: string;
  status: string;
  priority?: string;
  /** Optional leading element (e.g. a time column on the schedule). */
  leading?: ReactNode;
  onPress?: () => void;
}

// One job row shared by the dashboard lists, the office Jobs list, and the
// schedule agenda: "#num — title", a subtitle (customer · assignee), and
// status/priority pills. Read-only; money never appears here (parity with web).
export function JobListRow({ jobNumber, title, subtitle, status, priority, leading, onPress }: JobListRowProps) {
  const s = statusColors[status] ?? { bg: colors.slate100, text: colors.slate500 };
  const p = priority ? priorityColors[priority] ?? { bg: colors.slate100, text: colors.slate500 } : null;
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} disabled={!onPress} activeOpacity={0.6} testID="job-list-row">
      {leading}
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>
          #{jobNumber} — {title}
        </Text>
        {!!subtitle && <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text>}
      </View>
      <View style={styles.pills}>
        {p && (
          <View style={[styles.pill, { backgroundColor: p.bg }]}>
            <Text style={[styles.pillText, { color: p.text }]}>{humanize(priority!)}</Text>
          </View>
        )}
        <View style={[styles.pill, { backgroundColor: s.bg }]}>
          <Text style={[styles.pillText, { color: s.text }]}>{humanize(status)}</Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: 1, borderTopColor: colors.border },
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 14, fontWeight: "600", color: colors.slate900 },
  subtitle: { fontSize: 12, color: colors.slate500, marginTop: 2 },
  pills: { flexDirection: "row", alignItems: "center", gap: 6 },
  pill: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  pillText: { fontSize: 11, fontWeight: "600", textTransform: "capitalize" },
});
