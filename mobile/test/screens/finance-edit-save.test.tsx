import { render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import { Alert } from "react-native";

// Screen tests live under test/ and NOT beside the screen: expo-router's route
// regex (expo-router/_ctx) matches every .tsx under app/ and does not exclude
// `.test.tsx`, so a colocated test file would be published as a route.

const mockReplace = jest.fn();
jest.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ replace: mockReplace, back: jest.fn(), push: jest.fn() }),
  useLocalSearchParams: () => ({ id: "row-1" }),
}));
jest.mock("@react-native-community/datetimepicker", () => "DateTimePicker");

// lib/supabase asserts EXPO_PUBLIC_* at import time and the screen reaches it
// transitively (line-items-editor -> MoneyText -> useRole -> auth-context).
jest.mock("../../lib/supabase", () => ({ supabase: {} }));

// AsyncStorage is a native module: importing it under Jest throws before a
// single assertion runs, and the screen reaches it through lib/supabase.
jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

// MoneyText (inside the line-items editor) is role-aware and useAuth throws
// outside its provider. These screens are office/admin-only anyway.
jest.mock("../../lib/auth-context", () => ({
  useAuth: () => ({ profile: { id: "u1", role: "admin" } }),
}));

const mockEditInvoice = jest.fn();
const mockEditQuote = jest.fn();
jest.mock("../../lib/data/hooks/useFinance", () => ({
  useFinance: () => ({ ready: true, editInvoice: mockEditInvoice, editQuote: mockEditQuote }),
}));

const mockWriteOutcome = jest.fn();
jest.mock("../../lib/data/hooks/useWriteOutcome", () => ({
  useWriteOutcome: () => mockWriteOutcome,
}));

const mockGetInvoice = jest.fn();
const mockGetQuote = jest.fn();
jest.mock("../../lib/data/reads/finance", () => ({
  getInvoice: (id: string) => mockGetInvoice(id),
  getQuote: (id: string) => mockGetQuote(id),
}));

import EditInvoiceScreen from "../../app/invoices/[id]/edit";
import EditQuoteScreen from "../../app/quotes/[id]/edit";

const ITEM = { id: "li-1", name: "Backflow retest", description: null, quantity: 1, unit_price: 250 };

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, "alert").mockImplementation(() => {});
  mockGetInvoice.mockResolvedValue({
    id: "row-1",
    invoice_number: 12,
    title: "Annual retest",
    due_date: null,
    notes: null,
    customers: { name: "Acme" },
    invoice_items: [ITEM],
  });
  mockGetQuote.mockResolvedValue({
    id: "row-1",
    quote_number: 7,
    title: "Backflow install",
    valid_until: null,
    notes: null,
    customers: { name: "Acme" },
    quote_items: [ITEM],
  });
  mockWriteOutcome.mockResolvedValue("settled");
});

// Each case is the same shape on both screens, so drive them from one table.
// The two files are byte-for-byte siblings; a fix applied to one and not the
// other is exactly the drift that produced this bug.
const SCREENS = [
  {
    what: "invoice",
    Screen: EditInvoiceScreen,
    write: mockEditInvoice,
    detail: "/invoices/row-1",
  },
  {
    what: "quote",
    Screen: EditQuoteScreen,
    write: mockEditQuote,
    detail: "/quotes/row-1",
  },
] as const;

describe.each(SCREENS)("Edit $what screen — save outcomes", ({ Screen: EditScreen, write, detail }) => {
  async function renderAndSave() {
    render(<EditScreen />);
    const button = await screen.findByText("Save changes");
    fireEvent.press(button);
    return button;
  }

  it("tells the user when the write throws, instead of returning to the form as if it saved", async () => {
    write.mockRejectedValue(new Error("network down"));

    await renderAndSave();

    await waitFor(() => expect(Alert.alert).toHaveBeenCalled());
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("tells the user when the server rejected the write, and does not navigate away", async () => {
    write.mockResolvedValue({ result: undefined, synced: true });
    mockWriteOutcome.mockResolvedValue("failed");

    await renderAndSave();

    await waitFor(() => expect(Alert.alert).toHaveBeenCalled());
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("navigates to the detail when the server accepted the write", async () => {
    write.mockResolvedValue({ result: undefined, synced: true });
    mockWriteOutcome.mockResolvedValue("settled");

    await renderAndSave();

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith(detail));
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it("says so when the edit is only queued offline", async () => {
    write.mockResolvedValue({ result: undefined, synced: false });

    await renderAndSave();

    await waitFor(() => expect(Alert.alert).toHaveBeenCalled());
    expect(mockWriteOutcome).not.toHaveBeenCalled();
  });
});
