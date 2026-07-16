export const dynamic = "force-dynamic";

import { createClient } from "@/lib/supabase/server";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Plus, MapPin, CheckCircle2, XCircle, Mail, FileDown } from "lucide-react";
import { formatDate } from "@/lib/date";
import {
  computeNextDueDate,
  getDueStatus,
  getDeviceTypeLabel,
  getWaterAuthorityLabel,
  DUE_STATUS_LABELS,
  DueStatus,
} from "@/lib/backflow";

const STATUS_STYLES: Record<DueStatus, string> = {
  overdue: "bg-red-100 text-red-700 border-red-200",
  due_soon: "bg-amber-100 text-amber-700 border-amber-200",
  ok: "bg-green-100 text-green-700 border-green-200",
  no_test: "bg-slate-100 text-slate-600 border-slate-200",
};

export default async function BackflowDevicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: device } = await supabase
    .from("backflow_devices")
    .select("*, customers(name), sites(name, address_line1, suburb, state, postcode)")
    .eq("id", id)
    .single();

  if (!device) notFound();

  const { data: tests } = await supabase
    .from("backflow_tests")
    .select("*, profiles!backflow_tests_tested_by_fkey(full_name)")
    .eq("device_id", id)
    .order("test_date", { ascending: false });

  const lastPass = (tests ?? []).find((t: any) => t.result === "pass");
  const nextDueDate = computeNextDueDate(lastPass?.test_date, Number(device.test_frequency_months));
  const status = getDueStatus(nextDueDate);

  const address = device.sites
    ? [device.sites.address_line1, device.sites.suburb, device.sites.state, device.sites.postcode].filter(Boolean).join(", ")
    : null;

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/dashboard/backflow">
          <Button variant="ghost" size="sm" className="gap-2 text-slate-500">
            <ArrowLeft className="w-4 h-4" /> Back
          </Button>
        </Link>
      </div>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">{device.customers?.name ?? "Unknown customer"}</h1>
          <div className="flex items-center gap-3 mt-1.5 flex-wrap text-sm text-slate-500">
            {address && <span className="flex items-center gap-1"><MapPin className="w-3.5 h-3.5" />{address}</span>}
            <span>{getWaterAuthorityLabel(device.water_authority)}</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Badge className={`${STATUS_STYLES[status]} border`}>{DUE_STATUS_LABELS[status]}</Badge>
          <Link href={`/dashboard/backflow/${id}/test/new`}>
            <Button className="gap-2"><Plus className="w-4 h-4" />Log Test</Button>
          </Link>
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Device Details</CardTitle></CardHeader>
        <CardContent className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
          <div><p className="text-xs text-slate-400 uppercase">Device Type</p><p className="mt-0.5">{getDeviceTypeLabel(device.device_type)}</p></div>
          <div><p className="text-xs text-slate-400 uppercase">Make / Model</p><p className="mt-0.5">{[device.make, device.model].filter(Boolean).join(" / ") || "—"}</p></div>
          <div><p className="text-xs text-slate-400 uppercase">Serial No.</p><p className="mt-0.5">{device.serial_number ?? "—"}</p></div>
          <div><p className="text-xs text-slate-400 uppercase">Size</p><p className="mt-0.5">{device.size_mm ? `${device.size_mm} mm` : "—"}</p></div>
          <div><p className="text-xs text-slate-400 uppercase">Location</p><p className="mt-0.5">{device.location_description ?? "—"}</p></div>
          <div><p className="text-xs text-slate-400 uppercase">Test Frequency</p><p className="mt-0.5">Every {device.test_frequency_months} months</p></div>
          <div><p className="text-xs text-slate-400 uppercase">Next Due</p><p className="mt-0.5">{nextDueDate ? formatDate(nextDueDate, { day: "numeric", month: "short", year: "numeric" }) : "—"}</p></div>
          <div><p className="text-xs text-slate-400 uppercase">Water Meter No.</p><p className="mt-0.5">{device.water_meter_number ?? "—"}</p></div>
          <div><p className="text-xs text-slate-400 uppercase">Property No.</p><p className="mt-0.5">{device.water_authority_property_number ?? "—"}</p></div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Test History</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {(!tests || tests.length === 0) && <p className="text-sm text-slate-400">No tests logged yet</p>}
          {(tests ?? []).map((t: any) => (
            <div key={t.id} className="flex items-center justify-between gap-4 border rounded-lg px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  {t.result === "pass" ? <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" /> : <XCircle className="w-4 h-4 text-red-600 shrink-0" />}
                  <p className="font-medium text-sm text-slate-900">{formatDate(t.test_date, { day: "numeric", month: "short", year: "numeric" })} — {t.test_type.replace(/_/g, " ")}</p>
                </div>
                <p className="text-xs text-slate-500 mt-0.5">Tested by {t.tester_name}{t.profiles?.full_name ? ` (${t.profiles.full_name})` : ""}</p>
              </div>
              <div className="text-right shrink-0">
                {t.submitted_to_water_authority_at ? (
                  <span className="text-xs text-green-700 flex items-center gap-1 justify-end"><Mail className="w-3 h-3" />Submitted to {getWaterAuthorityLabel(device.water_authority)}</span>
                ) : (
                  <span className="text-xs text-amber-600">Not yet submitted</span>
                )}
                {t.certificate_storage_path && (
                  <a href={`/api/backflow/tests/${t.id}/certificate`} target="_blank" rel="noreferrer" className="text-xs text-blue-600 hover:underline flex items-center gap-1 justify-end mt-1">
                    <FileDown className="w-3 h-3" />View PDF
                  </a>
                )}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
