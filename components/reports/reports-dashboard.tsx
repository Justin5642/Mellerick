"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import { DollarSign, TrendingUp, AlertTriangle, Target, Briefcase, Users, HeartPulse, Truck } from "lucide-react";
import { jobStatusChartColors, quoteStatusChartColors } from "@/lib/badge-colors";

function money(n: number) {
  return `$${n.toLocaleString("en-AU", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

interface Props {
  revenueByMonth: { month: string; paid: number; outstanding: number }[];
  totalRevenuePaid: number;
  totalOutstanding: number;
  totalOverdue: number;
  quoteStatusCounts: Record<string, number>;
  winRate: number;
  acceptedValue: number;
  jobStatusCounts: Record<string, number>;
  jobsByStaff: { name: string; total: number; completed: number }[];
  topCustomers: { name: string; total: number }[];
  totalJobs: number;
  totalQuotes: number;
  staffEfficiency: {
    name: string;
    loadedHourlyRate: number;
    workedHours: number;
    sickHours: number;
    leaveHours: number;
    utilizationPct: number | null;
    trueCostPerWorkedHour: number | null;
  }[] | null;
  equipmentUtilization: {
    name: string;
    hoursUsed: number;
    budgetedCostPerHour: number;
    annualTotalCost: number;
    utilizationPct: number | null;
    trueCostPerHourUsed: number | null;
  }[];
}

export function ReportsDashboard({
  revenueByMonth,
  totalRevenuePaid,
  totalOutstanding,
  totalOverdue,
  quoteStatusCounts,
  winRate,
  acceptedValue,
  jobStatusCounts,
  jobsByStaff,
  topCustomers,
  totalJobs,
  totalQuotes,
  staffEfficiency,
  equipmentUtilization,
}: Props) {
  const quotePieData = Object.entries(quoteStatusCounts)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => ({ name: status, value: count }));

  const jobPieData = Object.entries(jobStatusCounts)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => ({ name: status.replace("_", " "), value: count, key: status }));

  const maxCustomerSpend = Math.max(1, ...topCustomers.map((c) => c.total));

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Reports &amp; Analytics</h1>
        <p className="text-slate-500 text-sm mt-1">Revenue, quotes, jobs and customer performance at a glance</p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-slate-500 text-xs mb-1"><DollarSign className="w-3.5 h-3.5" />Revenue Collected</div>
            <p className="text-xl font-bold text-slate-900">{money(totalRevenuePaid)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-slate-500 text-xs mb-1"><TrendingUp className="w-3.5 h-3.5" />Outstanding</div>
            <p className="text-xl font-bold text-blue-600">{money(totalOutstanding)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-slate-500 text-xs mb-1"><AlertTriangle className="w-3.5 h-3.5" />Overdue</div>
            <p className="text-xl font-bold text-red-600">{money(totalOverdue)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-slate-500 text-xs mb-1"><Target className="w-3.5 h-3.5" />Quote Win Rate</div>
            <p className="text-xl font-bold text-slate-900">{winRate.toFixed(0)}%</p>
            <p className="text-xs text-slate-400 mt-0.5">{money(acceptedValue)} won · {totalQuotes} quotes</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2 text-slate-500 text-xs mb-1"><Briefcase className="w-3.5 h-3.5" />Total Jobs</div>
            <p className="text-xl font-bold text-slate-900">{totalJobs}</p>
            <p className="text-xs text-slate-400 mt-0.5">{jobStatusCounts.completed ?? 0} completed</p>
          </CardContent>
        </Card>
      </div>

      {/* Revenue by month */}
      <Card>
        <CardHeader><CardTitle className="text-base">Revenue by Month</CardTitle></CardHeader>
        <CardContent>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={revenueByMonth}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} tickFormatter={(v) => `$${v}`} />
                <Tooltip formatter={(value: any) => money(Number(value))} />
                <Legend />
                <Bar dataKey="paid" name="Paid" fill="#22c55e" radius={[4, 4, 0, 0]} />
                <Bar dataKey="outstanding" name="Outstanding" fill="#3b82f6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle className="text-base">Quote Status Breakdown</CardTitle></CardHeader>
          <CardContent>
            {quotePieData.length === 0 ? (
              <p className="text-sm text-slate-400 py-12 text-center">No quotes yet</p>
            ) : (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={quotePieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label={(d: any) => `${d.name} (${d.value})`}>
                      {quotePieData.map((entry) => (
                        <Cell key={entry.name} fill={quoteStatusChartColors[entry.name] ?? "#94a3b8"} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Job Status Breakdown</CardTitle></CardHeader>
          <CardContent>
            {jobPieData.length === 0 ? (
              <p className="text-sm text-slate-400 py-12 text-center">No jobs yet</p>
            ) : (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={jobPieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label={(d: any) => `${d.name} (${d.value})`}>
                      {jobPieData.map((entry: any) => (
                        <Cell key={entry.key} fill={jobStatusChartColors[entry.key] ?? "#94a3b8"} />
                      ))}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle className="text-base">Top Customers by Spend</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {topCustomers.length === 0 ? (
              <p className="text-sm text-slate-400 py-8 text-center">No invoiced customers yet</p>
            ) : (
              topCustomers.map((c) => (
                <div key={c.name} className="space-y-1">
                  <div className="flex justify-between text-sm">
                    <span className="font-medium text-slate-700 truncate">{c.name}</span>
                    <span className="text-slate-500">{money(c.total)}</span>
                  </div>
                  <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                    <div
                      className="h-full bg-blue-500 rounded-full"
                      style={{ width: `${(c.total / maxCustomerSpend) * 100}%` }}
                    />
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="w-4 h-4" /> Jobs by Staff Member
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {jobsByStaff.length === 0 ? (
              <p className="text-sm text-slate-400 py-8 text-center">No jobs assigned to staff yet</p>
            ) : (
              jobsByStaff.map((s) => {
                const rate = s.total > 0 ? (s.completed / s.total) * 100 : 0;
                return (
                  <div key={s.name} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span className="font-medium text-slate-700 truncate">{s.name}</span>
                      <span className="text-slate-500">{s.completed}/{s.total} completed</span>
                    </div>
                    <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
                      <div className="h-full bg-green-500 rounded-full" style={{ width: `${rate}%` }} />
                    </div>
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      </div>

      {staffEfficiency && staffEfficiency.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <HeartPulse className="w-4 h-4" /> Staff Cost &amp; Efficiency (trailing 12 months)
            </CardTitle>
            <p className="text-xs text-slate-400">
              True cost per hour actually worked, factoring in wage on-costs and paid leave taken — a higher figure than the
              loaded rate means more of that person&apos;s paid time went to leave rather than jobs. Admin only.
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-slate-500">
                    <th className="px-4 py-2 font-medium">Staff</th>
                    <th className="px-4 py-2 font-medium text-right">Loaded Rate</th>
                    <th className="px-4 py-2 font-medium text-right">Worked Hrs</th>
                    <th className="px-4 py-2 font-medium text-right">Sick Hrs</th>
                    <th className="px-4 py-2 font-medium text-right">Leave Hrs</th>
                    <th className="px-4 py-2 font-medium text-right">Utilization</th>
                    <th className="px-4 py-2 font-medium text-right">True Cost / Hr Worked</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {staffEfficiency.map((s) => {
                    const overLoaded = s.trueCostPerWorkedHour != null && s.trueCostPerWorkedHour > s.loadedHourlyRate * 1.1;
                    const lowUtilization = s.utilizationPct != null && s.utilizationPct < 85;
                    return (
                      <tr key={s.name}>
                        <td className="px-4 py-2.5 font-medium text-slate-700">{s.name}</td>
                        <td className="px-4 py-2.5 text-right text-slate-600">${s.loadedHourlyRate.toFixed(2)}</td>
                        <td className="px-4 py-2.5 text-right text-slate-600">{s.workedHours.toFixed(1)}</td>
                        <td className="px-4 py-2.5 text-right text-slate-600">{s.sickHours.toFixed(1)}</td>
                        <td className="px-4 py-2.5 text-right text-slate-600">{s.leaveHours.toFixed(1)}</td>
                        <td className={`px-4 py-2.5 text-right font-medium ${lowUtilization ? "text-orange-600" : "text-slate-600"}`}>
                          {s.utilizationPct != null ? `${s.utilizationPct.toFixed(0)}%` : "—"}
                        </td>
                        <td className={`px-4 py-2.5 text-right font-semibold ${overLoaded ? "text-red-600" : "text-slate-800"}`}>
                          {s.trueCostPerWorkedHour != null ? `$${s.trueCostPerWorkedHour.toFixed(2)}` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {equipmentUtilization.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Truck className="w-4 h-4" /> Equipment Cost &amp; Utilization (trailing 12 months)
            </CardTitle>
            <p className="text-xs text-slate-400">
              True cost per hour actually used, factoring in fixed costs (depreciation, insurance, maintenance, rego) that are
              incurred whether or not the item gets used. A true cost well above the budgeted rate means it&apos;s under-used —
              worth checking whether hiring on demand would be cheaper than owning it.
            </p>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-slate-500">
                    <th className="px-4 py-2 font-medium">Equipment</th>
                    <th className="px-4 py-2 font-medium text-right">Budgeted Rate</th>
                    <th className="px-4 py-2 font-medium text-right">Hours Used</th>
                    <th className="px-4 py-2 font-medium text-right">Utilization</th>
                    <th className="px-4 py-2 font-medium text-right">Annual Cost</th>
                    <th className="px-4 py-2 font-medium text-right">True Cost / Hr Used</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {equipmentUtilization.map((eq) => {
                    const overLoaded = eq.trueCostPerHourUsed != null && eq.trueCostPerHourUsed > eq.budgetedCostPerHour * 1.1;
                    const lowUtilization = eq.utilizationPct != null && eq.utilizationPct < 60;
                    return (
                      <tr key={eq.name}>
                        <td className="px-4 py-2.5 font-medium text-slate-700">{eq.name}</td>
                        <td className="px-4 py-2.5 text-right text-slate-600">${eq.budgetedCostPerHour.toFixed(2)}</td>
                        <td className="px-4 py-2.5 text-right text-slate-600">{eq.hoursUsed.toFixed(1)}</td>
                        <td className={`px-4 py-2.5 text-right font-medium ${lowUtilization ? "text-orange-600" : "text-slate-600"}`}>
                          {eq.utilizationPct != null ? `${eq.utilizationPct.toFixed(0)}%` : "—"}
                        </td>
                        <td className="px-4 py-2.5 text-right text-slate-600">
                          ${eq.annualTotalCost.toLocaleString("en-AU", { maximumFractionDigits: 0 })}
                        </td>
                        <td className={`px-4 py-2.5 text-right font-semibold ${overLoaded ? "text-red-600" : "text-slate-800"}`}>
                          {eq.trueCostPerHourUsed != null ? `$${eq.trueCostPerHourUsed.toFixed(2)}` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
