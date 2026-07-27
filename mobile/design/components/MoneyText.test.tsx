import { render, screen } from "@testing-library/react-native";
import { MoneyText, formatMoney } from "./MoneyText";

// Mock the auth seam so we can drive the role. This is the single most important
// behavioral test in the design system: technicians must NEVER see a dollar figure.
const mockUseAuth = jest.fn();
jest.mock("../../lib/auth-context", () => ({
  useAuth: () => mockUseAuth(),
}));

function asRole(role: string | null) {
  mockUseAuth.mockReturnValue({ profile: role ? { role } : null });
}

describe("MoneyText role gating", () => {
  it("renders the redaction placeholder for a technician regardless of amount", () => {
    asRole("technician");
    render(<MoneyText amount={1234.5} />);
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.queryByText(/1,234/)).toBeNull();
  });

  it("renders the formatted AUD amount for office", () => {
    asRole("office");
    render(<MoneyText amount={1234.5} />);
    expect(screen.getByText(/\$1,234\.50/)).toBeTruthy();
  });

  it("renders the formatted AUD amount for admin", () => {
    asRole("admin");
    render(<MoneyText amount={99} />);
    expect(screen.getByText(/\$99\.00/)).toBeTruthy();
  });

  it("redacts for an unknown/absent role (fail closed)", () => {
    asRole(null);
    render(<MoneyText amount={500} />);
    expect(screen.getByText("—")).toBeTruthy();
  });
});

describe("formatMoney", () => {
  it("formats numbers as AUD and dashes null/NaN", () => {
    expect(formatMoney(0)).toMatch(/\$0\.00/);
    expect(formatMoney(null)).toBe("—");
    expect(formatMoney(undefined)).toBe("—");
  });
});
