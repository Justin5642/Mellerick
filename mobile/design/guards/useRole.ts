import { useAuth } from "../../lib/auth-context";

export type Role = "admin" | "office" | "technician";

// The caller's role from the auth profile (null if not loaded).
export function useRole(): Role | null {
  const { profile } = useAuth();
  return (profile?.role as Role | undefined) ?? null;
}

// Mirrors the backend is_office_or_admin() helper — the gate for financial data.
export function useIsOfficeOrAdmin(): boolean {
  const role = useRole();
  return role === "admin" || role === "office";
}

export function useIsAdmin(): boolean {
  return useRole() === "admin";
}
