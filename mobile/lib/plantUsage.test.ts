jest.mock("./supabase", () => ({ supabase: { auth: { getSession: jest.fn() } } }));

import { defaultPlantLine } from "./plantUsage";

// A truck run defaults to the job's Transport line (Stage 7).
describe("defaultPlantLine", () => {
  const lines = [
    { id: "l-drain", name: "Sewer", costCentre: "Below Ground Drainage" },
    { id: "l-cart", name: "Transport", costCentre: "Transport" },
  ];

  it("puts a vehicle on the Transport line", () => {
    expect(defaultPlantLine("vehicle", lines)).toBe("l-cart");
  });

  it("leaves machinery, and jobs with no or two Transport lines, to the driver", () => {
    expect(defaultPlantLine("machinery", lines)).toBeNull();
    expect(defaultPlantLine("vehicle", [lines[0]])).toBeNull();
    expect(defaultPlantLine("vehicle", [...lines, { id: "l-cart-2", name: "Cartage", costCentre: "Transport" }])).toBeNull();
  });
});
