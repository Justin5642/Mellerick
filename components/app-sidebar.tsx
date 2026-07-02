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
  { href: "/dashboard/staff", label: "Staff", icon: Users },
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
    <aside
      className={cn(
        "flex flex-col h-full bg-slate-900 text-slate-100 transition-all duration-300 relative",
        collapsed ? "w-16" : "w-60"
      )}
    >
      {/* Logo */}
      <div className="flex items-center gap-3 px-4 py-5 border-b border-slate-700">
        <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-blue-500 flex-shrink-0">
          <Wrench className="w-4 h-4 text-white" />
        </div>
        {!collapsed && (
          <span className="font-bold text-sm tracking-wide truncate">Mellerick App</span>
        )}
      </div>

      {/* Collapse toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="absolute -right-3 top-6 z-10 flex items-center justify-center w-6 h-6 rounded-full bg-slate-700 border border-slate-600 text-slate-300 hover:bg-slate-600 transition-colors"
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
  );
}
