import type { ReactNode } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "../lib/theme";
import { useKeyboardVisible } from "../lib/useKeyboardVisible";

/**
 * A bottom-sheet modal for forms with text fields, built so the keyboard can
 * never cover the buttons. The trap it replaces: a sheet whose action row sat
 * at the end of its ScrollView (or under it, at the bottom of the screen), so
 * after typing a note the keyboard covered Next/Save and there was no obvious
 * way to put the keyboard away — Return in a multiline field adds a line.
 *
 *   * iOS: a KeyboardAvoidingView (padding) lifts the whole sheet above the
 *     keyboard. Android: RN's Modal window resizes for the keyboard by itself
 *     (SOFT_INPUT_ADJUST_RESIZE), so no avoiding view there — it would
 *     double-count.
 *   * Only the body scrolls; the footer is outside the ScrollView, so it is
 *     always on screen, directly above the keyboard while one is up.
 *   * The keyboard goes away on: a tap on the dimmed backdrop or the title, a
 *     tap on any non-interactive part of the form (keyboardShouldPersistTaps
 *     "handled"), dragging the form, or the "Done" bar that sits on top of the
 *     keyboard while it is up (both platforms — no per-field
 *     InputAccessoryView wiring to forget).
 *   * Fields inside should use fontSize ≥ 16 (KEYBOARD_SHEET_INPUT_FONT_SIZE),
 *     the size below which the web's iPhone Safari zooms; the same size reads
 *     better on site in the phone app.
 */
export const KEYBOARD_SHEET_INPUT_FONT_SIZE = 16;

interface Props {
  visible: boolean;
  onRequestClose: () => void;
  title?: ReactNode;
  /** The action row. Never scrolled, never under the keyboard. */
  footer?: ReactNode;
  children: ReactNode;
  contentContainerStyle?: StyleProp<ViewStyle>;
  testID?: string;
}

function hideKeyboard() {
  Keyboard.dismiss();
}

export function KeyboardSheet({ visible, onRequestClose, title, footer, children, contentContainerStyle, testID }: Props) {
  const insets = useSafeAreaInsets();
  const keyboardUp = useKeyboardVisible();

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onRequestClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={[styles.overlay, { paddingTop: insets.top + 24 }]}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={hideKeyboard} accessible={false} testID={testID ? `${testID}-backdrop` : undefined} />
        <View style={[styles.sheet, { paddingBottom: keyboardUp ? 0 : Math.max(insets.bottom, 12) + 8 }]} testID={testID}>
          {title != null && (
            <Pressable onPress={hideKeyboard} accessible={false} style={styles.titleWrap}>
              {typeof title === "string" ? <Text style={styles.title}>{title}</Text> : title}
            </Pressable>
          )}
          <ScrollView
            style={styles.body}
            contentContainerStyle={[styles.bodyContent, contentContainerStyle]}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
          >
            {children}
          </ScrollView>
          {footer != null && <View style={styles.footer}>{footer}</View>}
          {keyboardUp && (
            <View style={styles.doneBar}>
              <TouchableOpacity onPress={hideKeyboard} accessibilityRole="button" accessibilityLabel="Hide keyboard" style={styles.doneBtn} hitSlop={8}>
                <Text style={styles.doneText}>Done</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  // flexShrink lets the sheet give up height to the keyboard; the ScrollView
  // inside is what actually shrinks, the title and footer keep their size.
  sheet: { backgroundColor: colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, flexShrink: 1 },
  titleWrap: { paddingHorizontal: 16, paddingTop: 16 },
  title: { fontSize: 16, fontWeight: "800", color: colors.slate900, marginBottom: 12 },
  body: { flexGrow: 0, flexShrink: 1 },
  bodyContent: { paddingHorizontal: 16, paddingBottom: 8 },
  footer: { paddingHorizontal: 16, paddingTop: 10 },
  doneBar: {
    flexDirection: "row",
    justifyContent: "flex-end",
    marginTop: 10,
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.bg,
  },
  doneBtn: { paddingHorizontal: 8, paddingVertical: 4 },
  doneText: { color: colors.blue600, fontWeight: "700", fontSize: 16 },
});
