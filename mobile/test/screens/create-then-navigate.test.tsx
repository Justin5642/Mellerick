import type { ReactNode } from "react";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react-native";
import { Alert, Text, TouchableOpacity } from "react-native";

// The three create-then-navigate screens that had not adopted useWriteOutcome.
// `synced` only means "we were online when we flushed" — it is NOT the server's
// answer. Each of these navigated to a detail screen for a row the server had
// rejected, so the user landed on a record that never existed.
//
// Screen tests live under test/ and NOT beside the screen: expo-router's route
// regex (expo-router/_ctx) matches every .tsx under app/ without excluding
// `.test.tsx`, so a colocated test file would be published as a route.

const mockReplace = jest.fn();
const mockBack = jest.fn();
const mockPush = jest.fn();
const mockParams = jest.fn<Record<string, string>, []>(() => ({}));
jest.mock("expo-router", () => ({
  // Render headerRight, so a screen whose only entry point is a header button
  // (customers) can still be driven the way a user drives it.
  Stack: { Screen: ({ options }: { options?: { headerRight?: () => ReactNode } }) => options?.headerRight?.() ?? null },
  useRouter: () => ({ replace: mockReplace, back: mockBack, push: mockPush }),
  useLocalSearchParams: () => mockParams(),
}));
jest.mock("@react-native-community/datetimepicker", () => "DateTimePicker");
jest.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => children,
}));
jest.mock("expo-image-picker", () => ({
  requestCameraPermissionsAsync: jest.fn(),
  launchCameraAsync: jest.fn(),
}));

// AsyncStorage is a native module: importing it under Jest throws before a
// single assertion runs, and every screen reaches it through lib/supabase.
jest.mock("@react-native-async-storage/async-storage", () =>
  require("@react-native-async-storage/async-storage/jest/async-storage-mock")
);

// backflow/new.tsx reads its customer + site pickers straight off supabase and
// asks auth for the creating user. The other screens only import the module.
jest.mock("../../lib/supabase", () => {
  interface MockChain {
    select: () => MockChain;
    eq: () => MockChain;
    order: () => MockChain;
    then: (onFulfilled: (r: { data: unknown[] }) => unknown) => Promise<unknown>;
  }
  const rows = (data: unknown[]): MockChain => ({
    select: () => rows(data),
    eq: () => rows(data),
    order: () => rows(data),
    then: (onFulfilled) => Promise.resolve({ data }).then(onFulfilled),
  });
  return {
    supabase: {
      from: (table: string) => rows(table === "customers" ? [{ id: "cust-1", name: "Acme Plumbing" }] : []),
      auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    },
  };
});

// MoneyText is role-aware and useAuth throws outside its provider.
jest.mock("../../lib/auth-context", () => ({
  useAuth: () => ({ profile: { id: "user-1", role: "admin" } }),
}));

const mockCreateQuote = jest.fn();
jest.mock("../../lib/data/hooks/useFinance", () => ({
  useFinance: () => ({ ready: true, createQuote: mockCreateQuote }),
}));

const mockRegisterDevice = jest.fn();
jest.mock("../../lib/data/hooks/useBackflow", () => ({
  useBackflow: () => ({ ready: true, registerDevice: mockRegisterDevice }),
}));

jest.mock("../../lib/data/hooks/useCustomers", () => ({
  useCustomers: () => ({ ready: true, setFavorite: jest.fn() }),
}));

const mockGetCustomer = jest.fn();
const mockListCustomers = jest.fn();
jest.mock("../../lib/data/reads/customers", () => ({
  getCustomer: (id: string) => mockGetCustomer(id),
  listCustomers: (offset: number, limit: number, q?: string) => mockListCustomers(offset, limit, q),
}));

// The sheet is opened from a header button and owns its own form; the unit under
// test is what the CUSTOMERS SCREEN does with the (id, synced) it hands back.
const mockCustomerSaved = { id: "new-cust", synced: true };
// The stub lives outside the factory: NativeWind's babel plugin rewrites element
// creation to a module-level `_ReactNativeCSSInterop` binding, which a jest.mock
// factory may not close over. The factory below only forwards to it, lazily.
function MockCustomerFormSheet({ visible, onSaved }: { visible: boolean; onSaved: (id: string, synced: boolean) => void }) {
  if (!visible) return null;
  return (
    <TouchableOpacity onPress={() => onSaved(mockCustomerSaved.id, mockCustomerSaved.synced)}>
      <Text>Save customer</Text>
    </TouchableOpacity>
  );
}
jest.mock("../../components/customer/customer-form", () => ({
  CustomerFormSheet: (props: { visible: boolean; onSaved: (id: string, synced: boolean) => void }) =>
    MockCustomerFormSheet(props),
}));

const mockWriteOutcome = jest.fn();
jest.mock("../../lib/data/hooks/useWriteOutcome", () => ({
  useWriteOutcome: () => mockWriteOutcome,
}));

import NewQuoteScreen from "../../app/quotes/new";
import NewBackflowDeviceScreen from "../../app/backflow/new";
import CustomersScreen from "../../app/customers";

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Alert, "alert").mockImplementation(() => {});
  mockParams.mockReturnValue({});
  mockGetCustomer.mockResolvedValue({ id: "cust-1", name: "Acme Plumbing" });
  mockListCustomers.mockResolvedValue([]);
  mockWriteOutcome.mockResolvedValue("settled");
  mockCustomerSaved.id = "new-cust";
  mockCustomerSaved.synced = true;
});

describe("New quote screen — the server's answer decides the navigation", () => {
  async function renderAndSave() {
    // Arriving from a customer's "New Quote" shortcut prefills the customer, so
    // the picker modal isn't in the way of the thing being tested.
    mockParams.mockReturnValue({ customerId: "cust-1" });
    render(<NewQuoteScreen />);
    await screen.findByText("Acme Plumbing");
    fireEvent.changeText(screen.getByPlaceholderText("e.g. Backflow installation"), "Backflow install");
    fireEvent.changeText(screen.getByPlaceholderText("Item name"), "RPZD supply");
    fireEvent.press(screen.getByText("Create draft quote"));
  }

  it("does not open the detail for a quote the server rejected", async () => {
    mockCreateQuote.mockResolvedValue({ result: "quote-1", synced: true });
    mockWriteOutcome.mockResolvedValue("failed");

    await renderAndSave();

    await waitFor(() => expect(Alert.alert).toHaveBeenCalled());
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("opens the detail when the server accepted the quote", async () => {
    mockCreateQuote.mockResolvedValue({ result: "quote-1", synced: true });
    mockWriteOutcome.mockResolvedValue("settled");

    await renderAndSave();

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/quotes/quote-1"));
    expect(Alert.alert).not.toHaveBeenCalled();
  });
});

describe("Register backflow device screen — the server's answer decides the navigation", () => {
  async function renderAndSave() {
    render(<NewBackflowDeviceScreen />);
    // The pickers are tap-to-open sheets: open by placeholder, choose by label.
    const choose = async (placeholder: string, option: string) => {
      fireEvent.press(await screen.findByText(placeholder));
      fireEvent.press(await screen.findByText(option));
    };
    await choose("Select customer", "Acme Plumbing");
    // Choosing a customer kicks off the site lookup, which resolves to an empty
    // list and so changes nothing on screen to wait for. Flush it anyway, or its
    // setState lands outside act.
    await act(async () => {});
    await choose("Select water authority", "Yarra Valley Water");
    await choose("Select device type", "Double Check Valve (DCV)");
    await choose("Select protection type", "Containment protection");

    // Property no., make, model, serial, size and location are all required —
    // the water authority rejects a certificate missing any of them, so the
    // screen refuses to save. Fill by "still empty" rather than by position: a
    // value that satisfies every one of them beats index arithmetic that would
    // silently shift the day a field is added.
    for (let guard = 0; guard < 20; guard++) {
      const [empty] = screen.queryAllByDisplayValue("");
      if (!empty) break;
      fireEvent.changeText(empty, "20");
    }
    // "Register Device" is both the screen title and the submit button; the
    // button is the later of the two.
    const labels = screen.getAllByText("Register Device");
    fireEvent.press(labels[labels.length - 1]);
  }

  it("does not open the detail for a device the server rejected", async () => {
    mockRegisterDevice.mockResolvedValue({ id: "dev-1", synced: true });
    mockWriteOutcome.mockResolvedValue("failed");

    await renderAndSave();

    await waitFor(() => expect(Alert.alert).toHaveBeenCalled());
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("opens the detail when the server accepted the device", async () => {
    mockRegisterDevice.mockResolvedValue({ id: "dev-1", synced: true });
    mockWriteOutcome.mockResolvedValue("settled");

    await renderAndSave();

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/backflow/dev-1"));
    expect(Alert.alert).not.toHaveBeenCalled();
  });
});

describe("Customers screen — the server's answer decides the navigation", () => {
  async function renderAndSave() {
    render(<CustomersScreen />);
    fireEvent.press(await screen.findByLabelText("Add customer"));
    fireEvent.press(await screen.findByText("Save customer"));
  }

  it("does not open the detail for a customer the server rejected", async () => {
    mockWriteOutcome.mockResolvedValue("failed");

    await renderAndSave();

    await waitFor(() => expect(Alert.alert).toHaveBeenCalled());
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("opens the detail when the server accepted the customer", async () => {
    mockWriteOutcome.mockResolvedValue("settled");

    await renderAndSave();

    await waitFor(() => expect(mockPush).toHaveBeenCalledWith("/customers/new-cust"));
    expect(Alert.alert).not.toHaveBeenCalled();
  });
});
