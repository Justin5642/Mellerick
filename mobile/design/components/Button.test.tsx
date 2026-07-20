import { render, screen, fireEvent } from "@testing-library/react-native";
import { Button } from "./Button";

// Mock the haptics seam (London school — assert the collaboration).
jest.mock("expo-haptics", () => ({ selectionAsync: jest.fn() }));
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
