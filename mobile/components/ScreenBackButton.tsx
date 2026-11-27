import { StyleSheet, Text, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { colors } from "../lib/theme";
import { goBackOrHome } from "../lib/backTarget";
import { useIsOfficeOrAdmin } from "../design/guards/useRole";

/**
 * The "‹ Back" every stack screen with a native header shows (set once as the
 * root Stack's default `headerLeft`, app/_layout.tsx). The native arrow only
 * appears when a screen sits behind this one; a screen opened from a push
 * notification, a deep link or after a role re-gate has none, which is a dead
 * end on iOS (no hardware back). This one pops when it can, else goes home for
 * the role (lib/backTarget.ts).
 */
export function ScreenBackButton({ label = "Back" }: { label?: string }) {
  const router = useRouter();
  const isOfficeOrAdmin = useIsOfficeOrAdmin();
  return (
    <TouchableOpacity
      onPress={() => goBackOrHome(router, isOfficeOrAdmin)}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
      style={styles.btn}
      testID="screen-back"
    >
      <Ionicons name="chevron-back" size={24} color={colors.blue600} />
      <Text style={styles.text}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: { flexDirection: "row", alignItems: "center", minHeight: 44, paddingRight: 8, marginLeft: -6 },
  text: { fontSize: 17, color: colors.blue600 },
});
