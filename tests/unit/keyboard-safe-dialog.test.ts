import { describe, it, expect } from "vitest";
import { KEYBOARD_DIALOG_MARGIN, keyboardSafeDialogStyle } from "@/lib/use-visual-viewport";

// iPhone 14: 844pt layout viewport; with the keyboard up ~470pt is visible.
describe("keyboardSafeDialogStyle", () => {
  it("leaves the ordinary CSS centring alone when nothing covers the page", () => {
    expect(keyboardSafeDialogStyle(null)).toBeUndefined();
    expect(keyboardSafeDialogStyle({ height: 844, offsetTop: 0, layoutHeight: 844 })).toBeUndefined();
    // Safari's toolbar collapsing is not a keyboard.
    expect(keyboardSafeDialogStyle({ height: 800, offsetTop: 0, layoutHeight: 844 })).toBeUndefined();
  });

  it("fits the dialog — footer included — into the area above the keyboard", () => {
    const style = keyboardSafeDialogStyle({ height: 470, offsetTop: 0, layoutHeight: 844 })!;
    expect(style).toEqual({ top: "235px", maxHeight: `${470 - 2 * KEYBOARD_DIALOG_MARGIN}px` });
    const top = parseInt(style.top) - parseInt(style.maxHeight) / 2;
    expect(top + parseInt(style.maxHeight)).toBeLessThanOrEqual(470);
  });

  it("follows the visible area when Safari pans the page under the keyboard", () => {
    expect(keyboardSafeDialogStyle({ height: 470, offsetTop: 120, layoutHeight: 844 })!.top).toBe("355px");
  });

  it("never collapses to nothing on a tiny visible area", () => {
    expect(keyboardSafeDialogStyle({ height: 100, offsetTop: 0, layoutHeight: 844 })!.maxHeight).toBe("160px");
  });
});
