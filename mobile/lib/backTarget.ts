// Where a "Back" control goes when the native stack may have nothing behind
// the screen. A screen opened from a push notification, a deep link
// (mellerickfield://…), or left on top after the routes re-gate on a role
// change has no screen behind it, so the native header draws no back arrow and
// the user is stuck — an office user has no tab bar on a pushed screen either.
// Every stack screen therefore shows its own Back (components/ScreenBackButton):
// it pops when it can, otherwise it goes home for the role.
export type BackTarget = { kind: "pop" } | { kind: "replace"; path: "/dashboard" | "/" };

/** Office/admin land on the Dashboard tab; technicians on My Jobs ("/"). */
export function homeForRole(isOfficeOrAdmin: boolean): "/dashboard" | "/" {
  return isOfficeOrAdmin ? "/dashboard" : "/";
}

export function backTarget(canGoBack: boolean, isOfficeOrAdmin: boolean): BackTarget {
  if (canGoBack) return { kind: "pop" };
  return { kind: "replace", path: homeForRole(isOfficeOrAdmin) };
}

/** The router calls `backTarget` needs — kept narrow so it is easy to fake in tests. */
export interface BackRouter {
  canGoBack(): boolean;
  back(): void;
  replace(path: "/dashboard" | "/"): void;
}

/** Pop when there is a screen behind, else go home for the role. */
export function goBackOrHome(router: BackRouter, isOfficeOrAdmin: boolean): BackTarget {
  const target = backTarget(router.canGoBack(), isOfficeOrAdmin);
  if (target.kind === "pop") router.back();
  else router.replace(target.path);
  return target;
}
