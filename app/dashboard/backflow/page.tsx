export const dynamic = "force-dynamic";

import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Droplets, Plus, MapPin } from "lucide-react";
import { formatDate } from "@/lib/date";
import { computeNextDueDate, getDueStatus, getDeviceTypeLabel, getWaterAuthorityLabel, DUE_STATUS_LABELS, DueStatus } from "@/lib/backflow";

const STATUS_STYLES: Record<DueStatus, string> = {
  overdue: "bg-red-100 text-red-700 border-red-200",
  due_soon: "bg-amber-100 text-amber-700 border-amber-200",
  ok: "bg-green-100 text-green-700 border-green-200",
  no_test: "bg-slate-100 text-slate-600 border-slate-200",
};

const STATUS_ORDER: Record<DueStatus, number> = { overdue: 0, due_soon: 1, no_test: 2, ok: 3 };

export default async function BackflowDevicesPage() {
  const supabase = await createClient();

  const { data: devices } = await supabase
    .from("backflow_devices")
    .select("*, customers(name), sites(name, suburb), backflow_tests(test_date, result)")
    .eq("is_active", true)
    .order("created_at", { ascending: false });

  const rows = (devices ?? []).map((device: any) => {
    const passingTests = (device.backflow_tests ?? []).filter((t: any) => t.result === "pass");
    const lastPass = passingTests.sort((a: any, b: any) => (a.test_date < b.test_date ? 1 : -1))[0];
    const nextDueDate = computeNextDueDate(lastPass?.test_date, Number(device.test_frequency_months));
    const status = getDueStatus(nextDueDate);
    return { device, lastPass, nextDueDate, status };
  });

  rows.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (a.nextDueDate?.getTime() ?? 0) - (b.nextDueDate?.getTime() ?? 0));

  const overdueCount = rows.filter((r) => r.status === "overdue").length;
  const dueSoonCount = rows.filter((r) => r.status === "due_soon").length;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
            <Droplets className="w-6 h-6 text-blue-600" />
            Backflow Testing
          </h1>
          <p className="text-slate-500 text-sm mt-1">
            {rows.length} device{rows.length !== 1 ? "s" : ""} registered
            {overdueCount > 0 && <span className="text-red-600 font-medium"> · {overdueCount} overdue</span>}
            {dueSoonCount > 0 && <span className="text-amber-600 font-medium"> · {dueSoonCount} due soon</span>}
          </p>
        </div>
        <Link href="/dashboard/backflow/new">
          <Button className="gap-2"><Plus className="w-4 h-4" />Add Device</Button>
        </Link>
      </div>

      {rows.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-slate-400">
            <Droplets className="w-12 h-12 mb-3 opacity-40" />
            <p className="text-sm font-medium">No backflow devices registered yet</p>
            <p className="text-xs mt-1">Add a customer's device to start tracking test due dates</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {rows.map(({ device, nextDueDate, status }) => (
            <Link key={device.id} href={`/dashboard/backflow/${device.id}`}>
              <Card className="hover:shadow-md transition-shadow cursor-pointer">
                <CardContent className="flex items-center justify-between gap-4 py-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-semibold text-slate-900">{device.customers?.name ?? "Unknown customer"}</p>
                      <Badge variant="outline" className="text-xs font-normal">{getDeviceTypeLabel(device.device_type)}</Badge>
                    </div>
                    <div className="flex items-center gap-3 mt-1 flex-wrap text-xs text-slate-500">
                      {device.sites?.suburb && (
                        <span className="flex items-center gap-1"><MapPin className="w-3 h-3" />{device.sites.suburb}</span>
                      )}
                      <span>{getWaterAuthorityLabel(device.water_authority)}</span>
                      {device.serial_number && <span>S/N {device.serial_number}</span>}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <Badge className={`${STATUS_STYLES[status]} border`}>{DUE_STATUS_LABELS[status]}</Badge>
                    <p className="text-xs text-slate-400 mt-1">
                      {nextDueDate ? `Due ${formatDate(nextDueDate, { day: "numeric", month: "short", year: "numeric" })}` : "No passing test yet"}
                    </p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
