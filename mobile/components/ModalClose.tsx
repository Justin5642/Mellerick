import type { ReactNode } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "../lib/theme";

// Visible ways out of anything shown in a React Native Modal. iOS has no
// hardware back and swipe-down isn't obvious (and doesn't exist on a
// full-screen modal), so every modal shows one of these — Android's hardware
// back is the Modal's own onRequestClose. test/screens/way-out.test.ts
// checks every Modal in the app has both.

/** "✕ Close" (or "‹ Back") — top-left, ≥44pt, for headers of full-screen modals. */
export function ModalCloseButton({
  onPress,
  label = "Close",
  icon = "close",
  tone = "light",
  disabled,
}: {
  onPress: () => void;
  label?: string;
  icon?: "close" | "chevron-back";
  /** "dark" = white on a dark screen (camera preview, photo viewer). */
  tone?: "light" | "dark";
  disabled?: boolean;
}) {
  const color = tone === "dark" ? colors.white : colors.blue600;
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      style={[styles.closeBtn, tone === "dark" && styles.closeBtnDark]}
      testID="modal-close"
    >
      <Ionicons name={icon} size={24} color={color} />
      <Text style={[styles.closeText, { color }]}>{label}</Text>
    </TouchableOpacity>
  );
}

/** Header row for a full-screen modal: Close top-left, the title, an optional right slot. Owns the top inset. */
export function ModalHeader({
  title,
  onClose,
  closeLabel = "Close",
  right,
}: {
  title: string;
  onClose: () => void;
  closeLabel?: string;
  right?: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
      <ModalCloseButton onPress={onClose} label={closeLabel} />
      <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
        {title}
      </Text>
      {right ?? <View style={styles.rightSpacer} />}
    </View>
  );
}

/** A full-width "Cancel" at the foot of a picker sheet that otherwise only closed on a tap outside it. */
export function SheetCancelButton({ onPress, label = "Cancel" }: { onPress: () => void; label?: string }) {
  return (
    <TouchableOpacity onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={styles.cancel} testID="sheet-cancel">
      <Text style={styles.cancelText}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  closeBtn: { flexDirection: "row", alignItems: "center", gap: 2, minHeight: 44, minWidth: 44, paddingRight: 6 },
  closeBtnDark: { backgroundColor: "rgba(0,0,0,0.45)", borderRadius: 22, paddingHorizontal: 10 },
  closeText: { fontSize: 16, fontWeight: "700" },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
  },
  title: { flex: 1, fontSize: 16, fontWeight: "800", color: colors.slate900, textAlign: "center" },
  rightSpacer: { minWidth: 80 },
  cancel: { marginTop: 8, minHeight: 48, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: colors.slate100 },
  cancelText: { fontSize: 16, fontWeight: "700", color: colors.slate700 },
});
