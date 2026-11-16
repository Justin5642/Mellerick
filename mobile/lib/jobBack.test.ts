import { jobBackTarget } from "./jobBack";

describe("jobBackTarget", () => {
  it("pops when there is a screen behind", () => {
    expect(jobBackTarget(true, false)).toEqual({ kind: "pop" });
    expect(jobBackTarget(true, true)).toEqual({ kind: "pop" });
  });
  it("goes home for the role when there is nothing behind", () => {
    expect(jobBackTarget(false, false)).toEqual({ kind: "replace", path: "/" });
    expect(jobBackTarget(false, true)).toEqual({ kind: "replace", path: "/dashboard" });
  });
});
