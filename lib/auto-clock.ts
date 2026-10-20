// Whether someone is auto clocked in/out when they arrive at / leave a site.
//
// profiles.auto_clock (migration 0082): NULL means "by role" — technicians on,
// office and admin off, which was the only rule before the switch existed —
// and true/false is an admin's explicit choice for that person (an owner or
// office manager who also works on the tools). The mobile app applies the same
// rule in mobile/lib/trackingGate.ts; keep them in step.
export function autoClockEnabled(p: { role: string | null; auto_clock?: boolean | null }): boolean {
  return p.auto_clock ?? p.role === "technician";
}
