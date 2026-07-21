import { render, fireEvent, screen } from "@testing-library/react-native";
import { FinanceListRow } from "./FinanceListRow";

// FinanceListRow renders MoneyText, which gates on role. Mock the role hook to
// office so money renders (technician-redaction is covered by MoneyText's own
// test). Full mock — no requireActual, which would pull in the native auth/
// supabase/AsyncStorage chain.
jest.mock("../guards/useRole", () => ({
  useIsOfficeOrAdmin: () => true,
}));

describe("FinanceListRow", () => {
  it("renders number, title, subtitle, the formatted amount and status", () => {
    render(
      <FinanceListRow
        number="INV-0007"
        title="Backflow retest"
        subtitle="Acme Co · due 1/8/2026"
        amount={1234.5}
        statusDomain="invoiceStatus"
        statusValue="sent"
      />
    );
    expect(screen.getByText("INV-0007 — Backflow retest")).toBeTruthy();
    expect(screen.getByText("Acme Co · due 1/8/2026")).toBeTruthy();
    expect(screen.getByText("$1,234.50")).toBeTruthy(); // AUD formatted
    expect(screen.getByText("Sent")).toBeTruthy(); // StatusPill humanizes
  });

  it("calls onPress when tapped", () => {
    const onPress = jest.fn();
    render(<FinanceListRow number="QUO-0001" title="X" amount={0} statusDomain="quoteStatus" statusValue="draft" onPress={onPress} />);
    fireEvent.press(screen.getByTestId("finance-list-row"));
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
