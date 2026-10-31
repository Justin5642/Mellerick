import { View, Text, StyleSheet, TouchableOpacity, Linking } from "react-native";
import { colors } from "../../lib/theme";
import { useLocationTracking } from "../../lib/location-tracking";
import { autoClockMessage } from "../../lib/autoClockMessage";

// One line at the top of the Time tab: is the automatic clock working, and if
// not, why and what to change (lib/autoClockMessage.ts).
export function AutoClockStatus() {
  const msg = autoClockMessage(useLocationTracking());
  if (!msg) return null;
  const tone = msg.tone === "ok" ? styles.ok : msg.tone === "warn" ? styles.warn : styles.off;
  return (
    <View style={[styles.box, tone]}>
      <Text style={styles.text}>{msg.text}</Text>
      {msg.settings && (
        <TouchableOpacity onPress={() => Linking.openSettings()} style={styles.button} accessibilityLabel="Open Settings">
          <Text style={styles.buttonText}>Settings</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { marginHorizontal: 16, marginTop: 12, padding: 10, borderRadius: 8, flexDirection: "row", alignItems: "center", gap: 10 },
  ok: { backgroundColor: colors.green100 },
  warn: { backgroundColor: colors.orange100 },
  off: { backgroundColor: colors.slate100 },
  text: { flex: 1, fontSize: 13, color: colors.slate700 },
  button: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 8, backgroundColor: "#fff" },
  buttonText: { fontSize: 14, fontWeight: "700", color: colors.blue600 },
});
