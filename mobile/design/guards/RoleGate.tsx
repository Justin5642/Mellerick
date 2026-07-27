import { Fragment, type ReactNode } from "react";
import { useRole, type Role } from "./useRole";

export interface RoleGateProps {
  roles: Role[];
  children: ReactNode;
  /** Rendered when the caller's role is not in `roles` (default: nothing). */
  fallback?: ReactNode;
}

// Renders children only if the caller's role is allowed. Used both to hide
// nav entries and to guard screens (defense in depth) — RLS is the backstop.
export function RoleGate({ roles, children, fallback = null }: RoleGateProps) {
  const role = useRole();
  if (!role || !roles.includes(role)) return <Fragment>{fallback}</Fragment>;
  return <Fragment>{children}</Fragment>;
}
