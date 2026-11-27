import { backTarget, goBackOrHome, homeForRole, type BackRouter } from "./backTarget";

function fakeRouter(canGoBack: boolean) {
  const calls: string[] = [];
  const router: BackRouter = {
    canGoBack: () => canGoBack,
    back: () => calls.push("back"),
    replace: (p) => calls.push(`replace:${p}`),
  };
  return { router, calls };
}

describe("backTarget", () => {
  it("pops when there is a screen behind, whatever the role", () => {
    expect(backTarget(true, false)).toEqual({ kind: "pop" });
    expect(backTarget(true, true)).toEqual({ kind: "pop" });
  });
  it("goes home for the role when nothing is behind (notification, deep link, re-gate)", () => {
    expect(backTarget(false, false)).toEqual({ kind: "replace", path: "/" });
    expect(backTarget(false, true)).toEqual({ kind: "replace", path: "/dashboard" });
  });
  it("homeForRole", () => {
    expect(homeForRole(true)).toBe("/dashboard");
    expect(homeForRole(false)).toBe("/");
  });
});

describe("goBackOrHome", () => {
  it("calls back() when it can pop", () => {
    const { router, calls } = fakeRouter(true);
    expect(goBackOrHome(router, true)).toEqual({ kind: "pop" });
    expect(calls).toEqual(["back"]);
  });
  it("replaces with the role's home when it can't", () => {
    const tech = fakeRouter(false);
    goBackOrHome(tech.router, false);
    expect(tech.calls).toEqual(["replace:/"]);
    const office = fakeRouter(false);
    goBackOrHome(office.router, true);
    expect(office.calls).toEqual(["replace:/dashboard"]);
  });
});
