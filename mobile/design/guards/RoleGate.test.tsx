import { render, screen } from "@testing-library/react-native";
import { Text } from "react-native";
import { RoleGate } from "./RoleGate";

const mockUseAuth = jest.fn();
jest.mock("../../lib/auth-context", () => ({
  useAuth: () => mockUseAuth(),
}));
const asRole = (role: string | null) => mockUseAuth.mockReturnValue({ profile: role ? { role } : null });

describe("RoleGate", () => {
  it("renders children when the role is allowed", () => {
    asRole("admin");
    render(
      <RoleGate roles={["admin"]}>
        <Text>Secret</Text>
      </RoleGate>
    );
    expect(screen.getByText("Secret")).toBeTruthy();
  });

  it("hides children (renders fallback) when the role is not allowed", () => {
    asRole("technician");
    render(
      <RoleGate roles={["admin", "office"]} fallback={<Text>Nope</Text>}>
        <Text>Secret</Text>
      </RoleGate>
    );
    expect(screen.queryByText("Secret")).toBeNull();
    expect(screen.getByText("Nope")).toBeTruthy();
  });

  it("hides children when role is absent (fail closed)", () => {
    asRole(null);
    render(
      <RoleGate roles={["admin"]}>
        <Text>Secret</Text>
      </RoleGate>
    );
    expect(screen.queryByText("Secret")).toBeNull();
  });
});
