import { render, fireEvent, screen } from "@testing-library/react-native";
import { StatCard } from "./StatCard";

describe("StatCard", () => {
  it("renders the title and value", () => {
    render(<StatCard title="Active Jobs" value={12} icon="briefcase" iconColor="#3b82f6" />);
    expect(screen.getByText("Active Jobs")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
  });

  it("calls onPress when tapped", () => {
    const onPress = jest.fn();
    render(<StatCard title="Customers" value={5} icon="people" iconColor="#8b5cf6" onPress={onPress} />);
    fireEvent.press(screen.getByTestId("stat-card"));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
