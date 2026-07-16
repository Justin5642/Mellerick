"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ArrowLeft, Plus, Trash2, RotateCcw } from "lucide-react";
import Link from "next/link";
import { TEST_TYPES, FAILURE_REASONS } from "@/lib/backflow";

interface DeviceGroup {
  group_label: string;
  make: string;
  model: string;
  serial_number: string;
  size_mm: string;
  check_valve_1_kpa: string;
  check_valve_1_leaked: boolean | null;
  check_valve_2_kpa: string;
  check_valve_2_leaked: boolean | null;
  upstream_isolation_valve_tight: boolean | null;
  downstream_isolation_valve_tight: boolean | null;
  relief_valve_opened: boolean | null;
}

const GROUP_LABELS = ["Main Device", "By-pass Device", "PVB / SPVB / AVB"];

function emptyGroup(label: string): DeviceGroup {
  return {
    group_label: label,
    make: "",
    model: "",
    serial_number: "",
    size_mm: "",
    check_valve_1_kpa: "",
    check_valve_1_leaked: null,
    check_valve_2_kpa: "",
    check_valve_2_leaked: null,
    upstream_isolation_valve_tight: null,
    downstream_isolation_valve_tight: null,
    relief_valve_opened: null,
  };
}

function YesNoField({ label, value, onChange, yesLabel = "Yes", noLabel = "No" }: {
  label: string; value: boolean | null; onChange: (v: boolean | null) => void; yesLabel?: string; noLabel?: string;
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex gap-2">
        <Button type="button" size="sm" variant={value === true ? "default" : "outline"} onClick={() => onChange(value === true ? null : true)}>{yesLabel}</Button>
        <Button type="button" size="sm" variant={value === false ? "default" : "outline"} onClick={() => onChange(value === false ? null : false)}>{noLabel}</Button>
      </div>
    </div>
  );
}

export default function NewBackflowTestPage() {
  const { id: deviceId } = useParams<{ id: string }>();
  const router = useRouter();
  const supabase = createClient();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drawing, setDrawing] = useState(false);
  const [lastPos, setLastPos] = useState({ x: 0, y: 0 });
  const [hasSignature, setHasSignature] = useState(false);
  const [saving, setSaving] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  const [testType, setTestType] = useState("annual");
  const [testDate, setTestDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [permissionToTurnOffWater, setPermissionToTurnOffWater] = useState<boolean | null>(null);
  const [mainsPressureKpa, setMainsPressureKpa] = useState("");
  const [groups, setGroups] = useState<DeviceGroup[]>([emptyGroup("Main Device")]);
  const [strainerInstalled, setStrainerInstalled] = useState<boolean | null>(null);
  const [strainerCleaned, setStrainerCleaned] = useState<boolean | null>(null);
  const [isolatingValvesPadlocked, setIsolatingValvesPadlocked] = useState<boolean | null>(null);
  const [compliesWithAsNzs, setCompliesWithAsNzs] = useState<boolean | null>(null);
  const [result, setResult] = useState<"pass" | "fail">("pass");
  const [reasonForFailure, setReasonForFailure] = useState("");
  const [repairScheduledDate, setRepairScheduledDate] = useState("");
  const [testKitSerialNumber, setTestKitSerialNumber] = useState("");
  const [testKitCalibrationDate, setTestKitCalibrationDate] = useState("");
  const [testerName, setTesterName] = useState("");
  const [testerLicenceNumber, setTesterLicenceNumber] = useState("");
  const [testerPhone, setTesterPhone] = useState("");
  const [remarks, setRemarks] = useState("");

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setCurrentUserId(data.user?.id ?? null);
      if (data.user) {
        supabase.from("profiles").select("full_name").eq("id", data.user.id).single().then(({ data: profile }) => {
          if (profile?.full_name) setTesterName(profile.full_name);
        });
      }
    });
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "#1e293b";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
  }, []);

  function getPos(e: React.MouseEvent | React.TouchEvent, canvas: HTMLCanvasElement) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    if ("touches" in e) {
      return { x: (e.touches[0].clientX - rect.left) * scaleX, y: (e.touches[0].clientY - rect.top) * scaleY };
    }
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }

  function startDraw(e: React.MouseEvent | React.TouchEvent) {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    setDrawing(true);
    setHasSignature(true);
    setLastPos(getPos(e, canvas));
  }
  function draw(e: React.MouseEvent | React.TouchEvent) {
    e.preventDefault();
    if (!drawing) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const pos = getPos(e, canvas);
    ctx.beginPath();
    ctx.moveTo(lastPos.x, lastPos.y);
    ctx.lineTo(pos.x, pos.y);
    ctx.stroke();
    setLastPos(pos);
  }
  function stopDraw() { setDrawing(false); }
  function clearSignature() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    setHasSignature(false);
  }

  function updateGroup(index: number, patch: Partial<DeviceGroup>) {
    setGroups((prev) => prev.map((g, i) => (i === index ? { ...g, ...patch } : g)));
  }
  function addGroup() {
    if (groups.length >= 3) return;
    setGroups((prev) => [...prev, emptyGroup(GROUP_LABELS[prev.length] ?? `Device ${prev.length + 1}`)]);
  }
  function removeGroup(index: number) {
    setGroups((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!testerName.trim()) { toast.error("Authorised tester's name is required"); return; }
    if (result === "fail" && !reasonForFailure) { toast.error("Select a reason for failure"); return; }
    setSaving(true);

    let signatureStoragePath: string | null = null;
    if (hasSignature && canvasRef.current) {
      const blob = await new Promise<Blob | null>((resolve) => canvasRef.current!.toBlob(resolve, "image/png"));
      if (blob) {
        const path = `${deviceId}/signatures/${Date.now()}.png`;
        const { error: uploadError } = await supabase.storage.from("backflow-certificates").upload(path, blob, { contentType: "image/png" });
        if (uploadError) toast.error("Failed to save signature — continuing without it");
        else signatureStoragePath = path;
      }
    }

    const testResults = groups.map((g) => ({
      group_label: g.group_label,
      make: g.make || null,
      model: g.model || null,
      serial_number: g.serial_number || null,
      size_mm: g.size_mm ? Number(g.size_mm) : null,
      check_valve_1_kpa: g.check_valve_1_kpa ? Number(g.check_valve_1_kpa) : null,
      check_valve_1_leaked: g.check_valve_1_leaked,
      check_valve_2_kpa: g.check_valve_2_kpa ? Number(g.check_valve_2_kpa) : null,
      check_valve_2_leaked: g.check_valve_2_leaked,
      upstream_isolation_valve_tight: g.upstream_isolation_valve_tight,
      downstream_isolation_valve_tight: g.downstream_isolation_valve_tight,
      relief_valve_opened: g.relief_valve_opened,
    }));

    const { data: test, error } = await supabase
      .from("backflow_tests")
      .insert({
        device_id: deviceId,
        test_type: testType,
        test_date: testDate,
        result,
        mains_pressure_kpa: mainsPressureKpa ? Number(mainsPressureKpa) : null,
        permission_to_turn_off_water: permissionToTurnOffWater,
        strainer_installed: strainerInstalled,
        strainer_cleaned: strainerCleaned,
        isolating_valves_padlocked: isolatingValvesPadlocked,
        complies_with_as_nzs_3500_1: compliesWithAsNzs,
        reason_for_failure: result === "fail" ? reasonForFailure : null,
        repair_scheduled_date: result === "fail" && repairScheduledDate ? repairScheduledDate : null,
        test_kit_serial_number: testKitSerialNumber || null,
        test_kit_calibration_date: testKitCalibrationDate || null,
        tester_name: testerName,
        tester_licence_number: testerLicenceNumber || null,
        tester_phone: testerPhone || null,
        remarks: remarks || null,
        test_results: testResults,
        signature_storage_path: signatureStoragePath,
        tested_by: currentUserId,
      })
      .select("id")
      .single();

    if (error || !test) {
      toast.error(error?.message ?? "Failed to save test");
      setSaving(false);
      return;
    }

    toast.success("Test logged — submitting report to the water authority...");

    try {
      const res = await fetch(`/api/backflow/tests/${test.id}/submit`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      toast.success(`Report emailed to ${data.sentTo}`);
    } catch (err: any) {
      toast.error(`Test saved, but submission failed: ${err.message ?? "unknown error"} — retry from the device page`);
    }

    router.push(`/dashboard/backflow/${deviceId}`);
  }

  return (
    <div className="p-6 max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href={`/dashboard/backflow/${deviceId}`}>
          <Button variant="ghost" size="sm" className="gap-2 text-slate-500">
            <ArrowLeft className="w-4 h-4" /> Back
          </Button>
        </Link>
        <h1 className="text-2xl font-bold text-slate-900">Log Backflow Test</h1>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Test Details</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label>Test Type</Label>
                <Select value={testType} onValueChange={(v) => setTestType(v as string)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TEST_TYPES.map((t) => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="testDate">Date of Test</Label>
                <Input id="testDate" type="date" value={testDate} onChange={(e) => setTestDate(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="mainsPressure">Mains Pressure (kPa)</Label>
                <Input id="mainsPressure" type="number" value={mainsPressureKpa} onChange={(e) => setMainsPressureKpa(e.target.value)} />
              </div>
            </div>
            <YesNoField label="Permission Received to Turn Off Water" value={permissionToTurnOffWater} onChange={setPermissionToTurnOffWater} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Device Test Results</CardTitle>
            {groups.length < 3 && (
              <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={addGroup}>
                <Plus className="w-3.5 h-3.5" />Add Device Group
              </Button>
            )}
          </CardHeader>
          <CardContent className="space-y-6">
            {groups.map((g, i) => (
              <div key={i} className="space-y-4 border rounded-lg p-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-slate-700">{g.group_label}</p>
                  {groups.length > 1 && (
                    <Button type="button" variant="ghost" size="icon-sm" onClick={() => removeGroup(i)} className="text-slate-400 hover:text-red-600">
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  )}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="space-y-1.5"><Label className="text-xs">Make</Label><Input value={g.make} onChange={(e) => updateGroup(i, { make: e.target.value })} /></div>
                  <div className="space-y-1.5"><Label className="text-xs">Model</Label><Input value={g.model} onChange={(e) => updateGroup(i, { model: e.target.value })} /></div>
                  <div className="space-y-1.5"><Label className="text-xs">Serial No.</Label><Input value={g.serial_number} onChange={(e) => updateGroup(i, { serial_number: e.target.value })} /></div>
                  <div className="space-y-1.5"><Label className="text-xs">Size (mm)</Label><Input type="number" value={g.size_mm} onChange={(e) => updateGroup(i, { size_mm: e.target.value })} /></div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="text-xs">Check Valve 1 (kPa)</Label>
                    <Input type="number" value={g.check_valve_1_kpa} onChange={(e) => updateGroup(i, { check_valve_1_kpa: e.target.value })} />
                    <YesNoField label="" value={g.check_valve_1_leaked} onChange={(v) => updateGroup(i, { check_valve_1_leaked: v })} yesLabel="Leaked" noLabel="Closed tight" />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs">Check Valve 2 (kPa)</Label>
                    <Input type="number" value={g.check_valve_2_kpa} onChange={(e) => updateGroup(i, { check_valve_2_kpa: e.target.value })} />
                    <YesNoField label="" value={g.check_valve_2_leaked} onChange={(v) => updateGroup(i, { check_valve_2_leaked: v })} yesLabel="Leaked" noLabel="Closed tight" />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <YesNoField label="Upstream Isolation Valve" value={g.upstream_isolation_valve_tight} onChange={(v) => updateGroup(i, { upstream_isolation_valve_tight: v })} yesLabel="Tight" noLabel="Leaked" />
                  <YesNoField label="Downstream Isolation Valve" value={g.downstream_isolation_valve_tight} onChange={(v) => updateGroup(i, { downstream_isolation_valve_tight: v })} yesLabel="Tight" noLabel="Leaked" />
                  <YesNoField label="Relief Valve" value={g.relief_valve_opened} onChange={(v) => updateGroup(i, { relief_valve_opened: v })} yesLabel="Opened" noLabel="Didn't open" />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Compliance &amp; Result</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <YesNoField label="Strainer Installed" value={strainerInstalled} onChange={setStrainerInstalled} />
              <YesNoField label="Strainer Cleaned" value={strainerCleaned} onChange={setStrainerCleaned} />
              <YesNoField label="Isolating Valves Padlocked" value={isolatingValvesPadlocked} onChange={setIsolatingValvesPadlocked} />
              <YesNoField label="Complies with AS/NZS3500.1" value={compliesWithAsNzs} onChange={setCompliesWithAsNzs} />
            </div>
            <div className="space-y-2">
              <Label>Device Test Result</Label>
              <div className="flex gap-2">
                <Button type="button" variant={result === "pass" ? "default" : "outline"} onClick={() => setResult("pass")}>Pass</Button>
                <Button type="button" variant={result === "fail" ? "destructive" : "outline"} onClick={() => setResult("fail")}>Fail</Button>
              </div>
            </div>
            {result === "fail" && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-red-50 border border-red-100 rounded-lg p-4">
                <div className="space-y-2">
                  <Label>Reason for Failure</Label>
                  <Select value={reasonForFailure} onValueChange={(v) => setReasonForFailure(v as string)}>
                    <SelectTrigger><SelectValue placeholder="Select reason" /></SelectTrigger>
                    <SelectContent>
                      {FAILURE_REASONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Repair Scheduled Date</Label>
                  <Input type="date" value={repairScheduledDate} onChange={(e) => setRepairScheduledDate(e.target.value)} />
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Test Kit &amp; Authorised Tester</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2"><Label>Test Kit Serial No.</Label><Input value={testKitSerialNumber} onChange={(e) => setTestKitSerialNumber(e.target.value)} /></div>
              <div className="space-y-2"><Label>Test Kit Calibration Date</Label><Input type="date" value={testKitCalibrationDate} onChange={(e) => setTestKitCalibrationDate(e.target.value)} /></div>
              <div className="space-y-2"><Label>Authorised Tester's Name *</Label><Input value={testerName} onChange={(e) => setTesterName(e.target.value)} required /></div>
              <div className="space-y-2"><Label>Licence No.</Label><Input value={testerLicenceNumber} onChange={(e) => setTesterLicenceNumber(e.target.value)} /></div>
              <div className="space-y-2"><Label>Phone</Label><Input value={testerPhone} onChange={(e) => setTesterPhone(e.target.value)} /></div>
            </div>
            <div className="space-y-2">
              <Label>Remarks</Label>
              <Textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={2} />
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Signature</Label>
                <Button type="button" variant="ghost" size="sm" className="gap-1.5 text-xs" onClick={clearSignature}>
                  <RotateCcw className="w-3.5 h-3.5" />Clear
                </Button>
              </div>
              <div className="border-2 border-slate-200 rounded-xl overflow-hidden bg-slate-50">
                <canvas
                  ref={canvasRef}
                  width={600}
                  height={160}
                  className="w-full touch-none cursor-crosshair"
                  onMouseDown={startDraw}
                  onMouseMove={draw}
                  onMouseUp={stopDraw}
                  onMouseLeave={stopDraw}
                  onTouchStart={startDraw}
                  onTouchMove={draw}
                  onTouchEnd={stopDraw}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end gap-3">
          <Link href={`/dashboard/backflow/${deviceId}`}><Button variant="outline" type="button">Cancel</Button></Link>
          <Button type="submit" disabled={saving}>{saving ? "Submitting..." : "Save & Submit to Water Authority"}</Button>
        </div>
      </form>
    </div>
  );
}
