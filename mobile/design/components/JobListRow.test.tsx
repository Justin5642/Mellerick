import { render, fireEvent, screen } from "@testing-library/react-native";
import { JobListRow } from "./JobListRow";

describe("JobListRow", () => {
  it("renders the job number, title, subtitle and humanized status", () => {
    render(<JobListRow jobNumber={101} title="Backflow test" subtitle="Acme Co · Jo Tech" status="in_progress" />);
    expect(screen.getByText("#101 — Backflow test")).toBeTruthy();
    expect(screen.getByText("Acme Co · Jo Tech")).toBeTruthy();
    expect(screen.getByText("in progress")).toBeTruthy(); // underscore humanized
  });

  it("renders a priority pill when given", () => {
    render(<JobListRow jobNumber={1} title="X" status="scheduled" priority="urgent" />);
    expect(screen.getByText("urgent")).toBeTruthy();
    expect(screen.getByText("scheduled")).toBeTruthy();
  });

  it("calls onPress when tapped", () => {
    const onPress = jest.fn();
    render(<JobListRow jobNumber={1} title="X" status="pending" onPress={onPress} />);
    fireEvent.press(screen.getByTestId("job-list-row"));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
