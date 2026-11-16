// Where the job screen's Back button goes. The native header only draws its
// own back arrow when there is a screen behind this one; a job opened from a
// push notification, a deep link, or a route re-gate after a role change has
// none, which left the user stuck on the job with no way out but the tab bar
// (and an office user has no tab bar there). So the screen always shows a Back
// button: it pops when it can, otherwise it goes home for the role.
export type JobBackTarget = { kind: "pop" } | { kind: "replace"; path: "/dashboard" | "/" };

export function jobBackTarget(canGoBack: boolean, isOfficeOrAdmin: boolean): JobBackTarget {
  if (canGoBack) return { kind: "pop" };
  return { kind: "replace", path: isOfficeOrAdmin ? "/dashboard" : "/" };
}
