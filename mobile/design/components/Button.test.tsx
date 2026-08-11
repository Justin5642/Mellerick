import { render, screen, fireEvent } from "@testing-library/react-native";
import { Button } from "./Button";

// Mock the haptics seam (London school — assert the collaboration).
// Resolves, because the real selectionAsync returns Promise<void> and the
// component now attaches a .catch to it — a mock returning undefined made the
// test fail on a component that is correct, which is the mock lying about the
// API rather than the code being wrong.
jest.mock("expo-haptics", () => ({ selectionAsync: jest.fn(() => Promise.resolve()) }));
import * as Haptics from "expo-haptics";

describe("Button", () => {
  beforeEach(() => jest.clearAllMocks());

  it("fires onPress and triggers haptic feedback on press", () => {
    const onPress = jest.fn();
    render(<Button title="Save" onPress={onPress} />);
    fireEvent.press(screen.getByText("Save"));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
  });

  it("does not fire onPress while loading, and marks itself busy", () => {
    const onPress = jest.fn();
    render(<Button title="Save" onPress={onPress} loading />);
    const btn = screen.getByRole("button");
    fireEvent.press(btn);
    expect(onPress).not.toHaveBeenCalled();
    expect(btn.props.accessibilityState).toMatchObject({ busy: true, disabled: true });
  });

  it("does not fire onPress when disabled", () => {
    const onPress = jest.fn();
    render(<Button title="Save" onPress={onPress} disabled />);
    fireEvent.press(screen.getByRole("button"));
    expect(onPress).not.toHaveBeenCalled();
  });
});
