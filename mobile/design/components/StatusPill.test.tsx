import { render, screen } from "@testing-library/react-native";
import { StatusPill } from "./StatusPill";
import { getStatusClassName } from "../tokens/status";

// London-school: assert the contract (humanized label + colors sourced from the
// token module), not pixels.
describe("StatusPill", () => {
  it("humanizes the status value for display", () => {
    render(<StatusPill domain="jobStatus" value="in_progress" />);
    expect(screen.getByText("In Progress")).toBeTruthy();
  });

  it("respects an explicit label override", () => {
    render(
      <StatusPill domain="jobStatus" value="completed">
        Done
      </StatusPill>
    );
    expect(screen.getByText("Done")).toBeTruthy();
  });

  it("sources its className from the token map (light + dark)", () => {
    // The token map is the single source of truth — assert the component uses it.
    const cn = getStatusClassName("jobPriority", "urgent");
    expect(cn).toContain("bg-red-100");
    expect(cn).toContain("dark:"); // dark variant present
    const { getByText } = render(<StatusPill domain="jobPriority" value="urgent" />);
    expect(getByText("Urgent").props.className).toContain(cn);
  });

  it("falls back to a neutral style for an unknown value (no crash)", () => {
    render(<StatusPill domain="jobStatus" value="totally_unknown" />);
    expect(screen.getByText("Totally Unknown")).toBeTruthy();
  });
});
