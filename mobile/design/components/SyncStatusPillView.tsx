import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";

// Pure presentational pill — NO data-layer coupling, so it's trivially testable
// without the native SQLite/AsyncStorage stack. Renders nothing when fully
// synced (no clutter); an amber "Syncing N…" while writes are in flight; and a
// red, tappable "N not synced · Retry" when writes have terminally failed (dead)
// — the actionable state the reviews asked for.
export function SyncStatusPillView({
  pending,
  failed,
  onRetry,
}: {
  pending: number;
  failed: number;
  onRetry: () => void;
}) {
  if (failed > 0) {
    return (
      <TouchableOpacity
        style={[styles.pill, styles.failed]}
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel={`${failed} change${failed === 1 ? "" : "s"} not synced. Tap to retry.`}
        testID="sync-status-failed"
      >
        <Ionicons name="warning-outline" size={13} color={colors.red600} />
        <Text style={[styles.text, styles.failedText]}>{failed} not synced · Retry</Text>
      </TouchableOpacity>
    );
  }
  if (pending > 0) {
    return (
      <View style={[styles.pill, styles.pending]} testID="sync-status-pending" accessibilityLabel={`Syncing ${pending} changes`}>
        <ActivityIndicator size="small" color={colors.blue600} />
        <Text style={[styles.text, styles.pendingText]}>Syncing {pending}…</Text>
      </View>
    );
  }
  return null; // fully synced → show nothing
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    // subtle shadow so it reads as a floating chip over any screen
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  pending: { backgroundColor: colors.blue100, borderColor: colors.blue100 },
  pendingText: { color: colors.blue600 },
  failed: { backgroundColor: colors.red100, borderColor: colors.red600 },
  failedText: { color: colors.red600 },
  text: { fontSize: 12, fontWeight: "600" },
});
