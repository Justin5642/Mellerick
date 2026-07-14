"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  Users,
  Briefcase,
  Calendar,
  FileText,
  Receipt,
  Package,
  DollarSign,
  LogOut,
  Wrench,
  ChevronLeft,
  ChevronRight,
  Settings,
  ClipboardCheck,
  BarChart3,
  Truck,
  Menu,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useState } from "react";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/dashboard/jobs", label: "Jobs", icon: Briefcase },
  { href: "/dashboard/my-jobs", label: "My Jobs", icon: Wrench },
  { href: "/dashboard/approvals", label: "Approvals", icon: ClipboardCheck },
  { href: "/dashboard/schedule", label: "Schedule", icon: Calendar },
  { href: "/dashboard/customers", label: "Customers", icon: Users },
  { href: "/dashboard/quotes", label: "Quotes", icon: FileText },
  { href: "/dashboard/invoices", label: "Invoices", icon: Receipt },
  { href: "/dashboard/pricing", label: "Pricing", icon: DollarSign },
  { href: "/dashboard/inventory", label: "Inventory", icon: Package },
  { href: "/dashboard/fleet", label: "Fleet", icon: Truck },
  { href: "/dashboard/staff", label: "Staff", icon: Users },
  { href: "/dashboard/reports", label: "Reports", icon: BarChart3 },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
];

interface AppSidebarProps {
  userEmail?: string;
  userName?: string;
  userRole?: string;
}

export function AppSidebar({ userEmail, userName, userRole }: AppSidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();
  const [collapsed, setCollapsed] = useState(false);
  // Separate from `collapsed` (the desktop rail toggle) -- on phones there's
  // no room for a permanently-visible rail at all, so below md the sidebar
  // is an off-canvas drawer instead, opened via the hamburger button in the
  // mobile top bar and closed by tapping the backdrop or a nav link.
  const [mobileOpen, setMobileOpen] = useState(false);

  async function handleSignOut() {
    await supabase.auth.signOut();
    toast.success("Signed out");
    router.push("/login");
    router.refresh();
  }

  const initials = userName
    ? userName.split(" ").map((n) => n[0]).join("").toUpperCase().slice(0, 2)
    : userEmail?.slice(0, 2).toUpperCase() ?? "ME";

  return (
    <>
      {/* Mobile top bar -- replaces the always-visible desktop sidebar below
          md, since there's no room for a permanent rail on a phone. Fixed so
          it stays put while the page scrolls; layout.tsx pads the main
          content area to clear it. */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-40 h-14 bg-slate-900 border-b border-slate-700 flex items-center gap-3 px-4">
        <button
          onClick={() => setMobileOpen(true)}
          aria-label="Open navigation menu"
          className="text-slate-300 hover:text-white p-1 -ml-1"
        >
          <Menu className="w-6 h-6" />
        </button>
        <img src="/icon-192.png" alt="Mellerick Plumbing and Drainage" className="w-8 h-8 object-contain rounded" />
      </div>

      {/* Backdrop -- tapping it closes the drawer, same as picking a nav link */}
      {mobileOpen && (
        <div
          onClick={() => setMobileOpen(false)}
          aria-hidden
          className="md:hidden fixed inset-0 z-40 bg-black/50"
        />
      )}

      <aside
        className={cn(
          "flex flex-col h-full bg-slate-900 text-slate-100 transition-all duration-300",
          // Mobile: off-canvas drawer, fixed above everything, slides in/out.
          "fixed inset-y-0 left-0 z-50 w-64",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
          // Desktop (md+): back in normal flow, always visible, width driven
          // by the separate `collapsed` rail toggle instead.
          "md:relative md:z-auto md:translate-x-0",
          collapsed ? "md:w-16" : "md:w-60"
        )}
      >
        {/* Logo — white plate so the brand mark's dark text/blue outline reads
            clearly against the dark sidebar body. Collapsed state swaps to the
            square icon crop so it doesn't get squashed into the 64px rail. */}
        <div
          className={cn(
            // justify-between so the mobile close button sits at the far
            // right; md:justify-center re-centers the logo on desktop where
            // that button is hidden (justify-between with only one visible
            // child would otherwise leave it flush left instead of centered).
            "flex items-center justify-between md:justify-center border-b border-slate-700 bg-white flex-shrink-0",
            collapsed ? "px-2 py-3" : "px-4 py-4"
          )}
        >
          <img
            src={collapsed ? "/icon-192.png" : "/logo.png"}
            alt="Mellerick Plumbing and Drainage"
            className={collapsed ? "w-9 h-9 object-contain rounded" : "h-11 w-auto object-contain"}
          />
          {/* Close button -- mobile drawer only */}
          <button
            onClick={() => setMobileOpen(false)}
            aria-label="Close navigation menu"
            className="md:hidden text-slate-500 hover:text-slate-800 p-1"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Collapse toggle -- desktop rail only; mobile uses the drawer's own
            open/close controls instead */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="hidden md:flex absolute -right-3 top-6 z-10 items-center justify-center w-6 h-6 rounded-full bg-slate-700 border border-slate-600 text-slate-300 hover:bg-slate-600 transition-colors"
        >
          {collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronLeft className="w-3 h-3" />}
        </button>

        {/* Nav */}
        <nav className="flex-1 px-2 py-4 space-y-1 overflow-y-auto">
          {navItems.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || (href !== "/dashboard" && pathname.startsWith(href));
            return (
              <Link
                key={href}
                href={href}
                onClick={() => setMobileOpen(false)}
                className={cn(
                  "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors",
                  active
                    ? "bg-blue-600 text-white"
                    : "text-slate-400 hover:bg-slate-800 hover:text-slate-100"
                )}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                {!collapsed && <span className="truncate">{label}</span>}
              </Link>
            );
          })}
        </nav>

        {/* User + Sign out */}
        <div className="border-t border-slate-700 p-3 space-y-2">
          {!collapsed && (
            <div className="flex items-center gap-3 px-2 py-2">
              <Avatar className="w-8 h-8 flex-shrink-0">
                <AvatarFallback className="bg-blue-600 text-white text-xs">{initials}</AvatarFallback>
              </Avatar>
              <div className="overflow-hidden">
                <p className="text-xs font-medium truncate">{userName || userEmail}</p>
                <p className="text-xs text-slate-500 capitalize">{userRole}</p>
              </div>
            </div>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSignOut}
            className={cn(
              "w-full text-slate-400 hover:text-white hover:bg-slate-800",
              collapsed ? "px-0 justify-center" : "justify-start gap-2"
            )}
          >
            <LogOut className="w-4 h-4 flex-shrink-0" />
            {!collapsed && "Sign out"}
          </Button>
        </div>
      </aside>
    </>
  );
}
