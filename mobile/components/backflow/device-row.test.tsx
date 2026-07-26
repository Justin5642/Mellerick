import { render, fireEvent, screen } from "@testing-library/react-native";
import { BackflowDeviceRow } from "./device-row";
import type { BackflowRow } from "../../lib/data/reads/backflow";

function row(over: Partial<BackflowRow["device"]> = {}, nextDueDate: Date | null = null, status: BackflowRow["status"] = "no_test"): BackflowRow {
  return {
    device: {
      id: "d1",
      water_authority: "yarra_valley_water",
      serial_number: "SN-42",
      test_frequency_months: 12,
      customers: { name: "Acme Co" },
      sites: { name: "HQ", suburb: "Richmond" },
      backflow_tests: [],
      ...over,
    },
    nextDueDate,
    status,
  };
}

describe("BackflowDeviceRow", () => {
  it("renders customer, water authority, serial, suburb and the due date", () => {
    render(<BackflowDeviceRow row={row({}, new Date("2026-08-01"), "due_soon")} />);
    expect(screen.getByText("Acme Co")).toBeTruthy();
    expect(screen.getByText("Yarra Valley Water")).toBeTruthy(); // humanized authority
    expect(screen.getByText("S/N SN-42")).toBeTruthy();
    expect(screen.getByText("Richmond")).toBeTruthy();
    expect(screen.getByText("Due soon")).toBeTruthy(); // status label
    expect(screen.getByText("Due 1 Aug 2026")).toBeTruthy(); // en-AU formatted due date
  });

  it("shows the no-passing-test hint when there is no due date", () => {
    render(<BackflowDeviceRow row={row()} />);
    expect(screen.getByText("No passing test yet")).toBeTruthy();
  });

  it("calls onPress when tapped", () => {
    const onPress = jest.fn();
    render(<BackflowDeviceRow row={row()} onPress={onPress} />);
    fireEvent.press(screen.getByLabelText("Backflow device for Acme Co"));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
