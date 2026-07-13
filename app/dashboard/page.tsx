export const dynamic = "force-dynamic";

import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Briefcase, Users, Receipt, AlertCircle, CheckCircle2, Clock, DollarSign } from "lucide-react";
import Link from "next/link";
import { businessDateParts, formatDate } from "@/lib/date";

function StatCard({ title, value, icon: Icon, color, href }: {
  title: string; value: string | number; icon: React.ElementType; color: string; href: string;
}) {
  return (
    <Link href={href}>
      <Card className="hover:shadow-md transition-shadow cursor-pointer">
        <CardContent className="flex items-center gap-4 p-6">
          <div className={`flex items-center justify-center w-12 h-12 rounded-xl ${color}`}>
            <Icon className="w-6 h-6 text-white" />
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{title}</p>
            <p className="text-2xl font-bold">{value}</p>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

const statusColors: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  scheduled: "bg-blue-100 text-blue-800",
  in_progress: "bg-purple-100 text-purple-800",
  completed: "bg-green-100 text-green-800",
  cancelled: "bg-red-100 text-red-800",
  on_hold: "bg-gray-100 text-gray-800",
};

const priorityColors: Record<string, string> = {
  low: "bg-gray-100 text-gray-600",
  normal: "bg-blue-100 text-blue-700",
  high: "bg-orange-100 text-orange-700",
  urgent: "bg-red-100 text-red-700",
};

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  const [
    { count: totalJobs },
    { count: activeJobs },
    { count: totalCustomers },
    { count: overdueInvoices },
    { data: recentJobs },
    { data: profile },
  ] = await Promise.all([
    supabase.from("jobs").select("*", { count: "exact", head: true }),
    supabase.from("jobs").select("*", { count: "exact", head: true }).in("status", ["pending", "scheduled", "in_progress"]),
    supabase.from("customers").select("*", { count: "exact", head: true }).eq("is_active", true),
    supabase.from("invoices").select("*", { count: "exact", head: true }).eq("status", "overdue"),
    supabase.from("jobs")
      .select("*, customers(name), assigned_to:profiles(full_name)")
      .order("created_at", { ascending: false })
      .limit(8),
    supabase.from("profiles").select("full_name").eq("id", user!.id).single(),
  ]);

  const { hour } = businessDateParts();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const firstName = profile?.full_name?.split(" ")[0] ?? "there";

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-900">{greeting}, {firstName}</h1>
        <p className="text-slate-500 text-sm mt-1">{formatDate(new Date(), { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard title="Active Jobs" value={activeJobs ?? 0} icon={Briefcase} color="bg-blue-500" href="/dashboard/jobs" />
        <StatCard title="Total Jobs" value={totalJobs ?? 0} icon={CheckCircle2} color="bg-green-500" href="/dashboard/jobs" />
        <StatCard title="Customers" value={totalCustomers ?? 0} icon={Users} color="bg-violet-500" href="/dashboard/customers" />
        <StatCard title="Overdue Invoices" value={overdueInvoices ?? 0} icon={AlertCircle} color="bg-red-500" href="/dashboard/invoices" />
      </div>

      {/* Recent Jobs */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-base font-semibold">Recent Jobs</CardTitle>
          <Link href="/dashboard/jobs" className="text-sm text-blue-600 hover:underline font-medium">View all</Link>
        </CardHeader>
        <CardContent className="p-0">
          {!recentJobs || recentJobs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-400">
              <Briefcase className="w-10 h-10 mb-3 opacity-40" />
              <p className="text-sm">No jobs yet.</p>
              <Link href="/dashboard/jobs/new" className="mt-2 text-sm text-blue-600 hover:underline">Create your first job</Link>
            </div>
          ) : (
            <div className="divide-y">
              {recentJobs.map((job: any) => (
                <Link key={job.id} href={`/dashboard/jobs/${job.id}`} className="flex items-center justify-between px-6 py-4 hover:bg-slate-50 transition-colors group">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm text-slate-900 group-hover:text-blue-600 transition-colors truncate">
                        #{job.job_number} — {job.title}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5 truncate">
                      {job.customers?.name}
                      {(job.assigned_to as any)?.full_name ? ` · ${(job.assigned_to as any).full_name}` : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 ml-4 flex-shrink-0">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${priorityColors[job.priority] ?? ""}`}>
                      {job.priority}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${statusColors[job.status] ?? ""}`}>
                      {job.status.replace("_", " ")}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
