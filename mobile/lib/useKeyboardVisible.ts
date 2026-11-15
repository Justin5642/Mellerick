import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";

/**
 * Whether the on-screen keyboard is up. iOS announces it before it animates
 * ("will"), Android only after ("did") — each platform's earliest event, so a
 * control that rides above the keyboard appears with it.
 */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow", () => setVisible(true));
    const hide = Keyboard.addListener(Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide", () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}
