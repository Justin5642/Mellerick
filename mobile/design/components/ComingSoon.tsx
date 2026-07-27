import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Stack } from "expo-router";
import { colors } from "../../lib/theme";

// Honest placeholder for an office/admin area that's routed + role-gated but not
// yet built out. Sets the pushed screen's header title.
export function ComingSoon({ title, note }: { title: string; note?: string }) {
  return (
    <>
      <Stack.Screen options={{ headerShown: true, title }} />
      <View style={styles.container}>
        <Ionicons name="construct-outline" size={40} color={colors.slate400} />
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.note}>{note ?? "This area is coming to the mobile app soon."}</Text>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 10, backgroundColor: colors.bg },
  title: { fontSize: 18, fontWeight: "700", color: colors.slate700 },
  note: { fontSize: 13, color: colors.slate400, textAlign: "center" },
});
