// The dashboard's route list, with no React and no icons, so both the sidebar
// and middleware.ts can import it.
//
// Kept separate from components/app-sidebar.tsx deliberately: middleware runs in
// the Edge runtime, and importing the sidebar there pulled React and the whole
// lucide icon set into the Edge bundle (109 kB) to read a list of strings.
//
// `tech: true` means a technician may open it. Everything else is office/admin.
//
// THIS IS NOT THE MONEY BOUNDARY AND MUST NEVER BECOME IT. RLS is, and stays:
// migrations 0027/0028/0034/0035/0038/0042/0045 already refuse a technician
// every financial row, so /dashboard/invoices renders empty and
// /dashboard/reports renders zeros with this file deleted. What it closes is
// confidentiality on the tables still carrying the wide-open baseline policy —
// the staff roster with colleague emails and phones (0000_baseline.sql:38), the
// customer book, and every job and schedule (baseline:131). Tightening those
// policies is the durable fix; this stops the app inviting people in meanwhile.

export type NavItem = { href: string; label: string; tech?: boolean };

export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/dashboard/jobs", label: "Jobs", tech: true },
  { href: "/dashboard/my-jobs", label: "My Jobs", tech: true },
  { href: "/dashboard/approvals", label: "Approvals" },
  { href: "/dashboard/schedule", label: "Schedule" },
  { href: "/dashboard/customers", label: "Customers" },
  { href: "/dashboard/quotes", label: "Quotes" },
  { href: "/dashboard/invoices", label: "Invoices" },
  { href: "/dashboard/pricing", label: "Pricing" },
  { href: "/dashboard/inventory", label: "Inventory" },
  { href: "/dashboard/fleet", label: "Fleet" },
  { href: "/dashboard/backflow", label: "Backflow Testing", tech: true },
  { href: "/dashboard/staff", label: "Staff" },
  { href: "/dashboard/reports", label: "Reports" },
  { href: "/dashboard/settings", label: "Settings" },
];

/** The routes one role may see. One definition, so the sidebar and the
 *  middleware redirect cannot drift into disagreeing. */
export function navItemsFor(role: string | undefined): NavItem[] {
  return role === "technician" ? NAV_ITEMS.filter((i) => i.tech) : NAV_ITEMS;
}

/** Whether a role may open a given dashboard path. */
export function mayOpen(role: string | undefined, path: string): boolean {
  return navItemsFor(role).some((i) => path === i.href || path.startsWith(`${i.href}/`));
}
