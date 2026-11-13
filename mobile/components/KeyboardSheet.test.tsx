import { Keyboard, ScrollView, Text, TextInput } from "react-native";
import { render, screen, fireEvent } from "@testing-library/react-native";
import { KeyboardSheet, KEYBOARD_SHEET_INPUT_FONT_SIZE } from "./KeyboardSheet";

let mockKeyboardUp = false;
jest.mock("../lib/useKeyboardVisible", () => ({ useKeyboardVisible: () => mockKeyboardUp }));
jest.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }) }));

function renderSheet() {
  return render(
    <KeyboardSheet visible onRequestClose={jest.fn()} title="Schedule job" footer={<Text>Next</Text>} testID="sheet">
      <TextInput testID="note" multiline />
    </KeyboardSheet>
  );
}

describe("KeyboardSheet", () => {
  beforeEach(() => {
    mockKeyboardUp = false;
    jest.restoreAllMocks();
  });

  it("keeps the footer outside the scrolling form, so the keyboard cannot scroll it away", () => {
    renderSheet();
    const scroll = screen.UNSAFE_getByType(ScrollView);
    expect(screen.getByTestId("note")).toBeTruthy();
    // The note is inside the ScrollView; Next is not.
    expect(scroll.findAllByProps({ testID: "note" }).length).toBeGreaterThan(0);
    expect(scroll.findAllByType(Text).some((t: { props: { children?: unknown } }) => t.props.children === "Next")).toBe(false);
    expect(screen.getByText("Next")).toBeTruthy();
  });

  it("dismisses the keyboard on taps outside a field and on drag", () => {
    renderSheet();
    const scroll = screen.UNSAFE_getByType(ScrollView);
    expect(scroll.props.keyboardShouldPersistTaps).toBe("handled");
    expect(scroll.props.keyboardDismissMode).toBe("on-drag");
    const dismiss = jest.spyOn(Keyboard, "dismiss").mockImplementation(() => {});
    fireEvent.press(screen.getByTestId("sheet-backdrop"));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("shows a Done bar only while the keyboard is up, and it hides the keyboard", () => {
    renderSheet();
    expect(screen.queryByLabelText("Hide keyboard")).toBeNull();

    mockKeyboardUp = true;
    renderSheet();
    const dismiss = jest.spyOn(Keyboard, "dismiss").mockImplementation(() => {});
    fireEvent.press(screen.getByLabelText("Hide keyboard"));
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it("asks fields for 16pt text", () => {
    expect(KEYBOARD_SHEET_INPUT_FONT_SIZE).toBeGreaterThanOrEqual(16);
  });
});
