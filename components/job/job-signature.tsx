"use client";

import { useRef, useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { CheckCircle2, RotateCcw, Save, PenLine, Mic } from "lucide-react";

interface Props {
  jobId: string;
  currentUserId: string;
  existingSignature?: string | null;
  voiceReportTranscript?: string | null;
}

export function JobSignature({ jobId, currentUserId, existingSignature, voiceReportTranscript }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [drawing, setDrawing] = useState(false);
  const [lastPos, setLastPos] = useState({ x: 0, y: 0 });
  const [signerName, setSignerName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [hasSignature, setHasSignature] = useState(false);

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
      return {
        x: (e.touches[0].clientX - rect.left) * scaleX,
        y: (e.touches[0].clientY - rect.top) * scaleY,
      };
    }
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  function startDraw(e: React.MouseEvent | React.TouchEvent) {
    e.preventDefault();
    const canvas = canvasRef.current;
    if (!canvas) return;
    setDrawing(true);
    setHasSignature(true);
    const pos = getPos(e, canvas);
    setLastPos(pos);
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

  function stopDraw() {
    setDrawing(false);
  }

  function clearCanvas() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    setHasSignature(false);
    setSaved(false);
  }

  async function handleSave() {
    if (!hasSignature) { toast.error("Please provide a signature first"); return; }
    const canvas = canvasRef.current;
    if (!canvas) return;
    setSaving(true);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) { setSaving(false); return; }

    const path = `${jobId}/signature_${Date.now()}.png`;
    const { error: uploadError } = await supabase.storage.from("job-photos").upload(path, blob, { contentType: "image/png" });
    if (uploadError) { toast.error("Failed to save signature"); setSaving(false); return; }

    await supabase.from("job_photos").insert({
      job_id: jobId,
      uploaded_by: currentUserId,
      storage_path: path,
      photo_type: "signature",
      caption: signerName || "Customer signature",
    });

    await supabase.from("jobs").update({
      completion_notes: `Signed off by: ${signerName || "Customer"} on ${new Date().toLocaleDateString("en-AU")}`,
      status: "completed",
      actual_end: new Date().toISOString(),
      ready_to_invoice: true,
    }).eq("id", jobId);

    fetch(`/api/jobs/${jobId}/sync-calendar`, { method: "POST" }).catch(() => {});

    toast.success("Job complete — flagged for office review");
    setSaved(true);
    setSaving(false);
  }

  const supabase = createClient();

  return (
    <div className="p-6 max-w-xl space-y-6">
      <div>
        <h2 className="text-base font-semibold text-slate-900">Customer Sign-Off</h2>
        <p className="text-sm text-slate-500">Capture customer signature to complete the job</p>
      </div>

      {saved || existingSignature ? (
        <Card className="border-green-200 bg-green-50">
          <CardContent className="flex items-center gap-4 p-6">
            <CheckCircle2 className="w-8 h-8 text-green-600 flex-shrink-0" />
            <div>
              <p className="font-semibold text-green-900">Job Signed Off</p>
              <p className="text-sm text-green-700">{existingSignature}</p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {voiceReportTranscript && (
        <Card className="border-blue-100 bg-blue-50/40">
          <CardContent className="p-4 space-y-1.5">
            <div className="flex items-center gap-2 text-blue-700">
              <Mic className="w-4 h-4" />
              <p className="text-sm font-semibold">Voice Report (transcribed)</p>
            </div>
            <p className="text-sm text-slate-600 whitespace-pre-wrap">{voiceReportTranscript}</p>
          </CardContent>
        </Card>
      )}

      <div className="space-y-2">
        <Label htmlFor="signerName">Customer Name</Label>
        <Input id="signerName" value={signerName} onChange={(e) => setSignerName(e.target.value)} placeholder="e.g. John Smith" />
      </div>

      <div className="space-y-2">
        <Label>Signature</Label>
        <div className="border-2 border-slate-200 rounded-xl overflow-hidden bg-slate-50 relative">
          <canvas
            ref={canvasRef}
            width={600}
            height={200}
            className="w-full touch-none cursor-crosshair"
            onMouseDown={startDraw}
            onMouseMove={draw}
            onMouseUp={stopDraw}
            onMouseLeave={stopDraw}
            onTouchStart={startDraw}
            onTouchMove={draw}
            onTouchEnd={stopDraw}
          />
          {!hasSignature && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="flex items-center gap-2 text-slate-300">
                <PenLine className="w-5 h-5" />
                <span className="text-sm">Sign here</span>
              </div>
            </div>
          )}
        </div>
        <p className="text-xs text-slate-400">Draw signature above using mouse or finger on touchscreen</p>
      </div>

      <div className="flex gap-3">
        <Button variant="outline" onClick={clearCanvas} className="gap-2">
          <RotateCcw className="w-4 h-4" />Clear
        </Button>
        <Button onClick={handleSave} disabled={saving || !hasSignature} className="gap-2 flex-1">
          <Save className="w-4 h-4" />
          {saving ? "Saving..." : "Save & Complete Job"}
        </Button>
      </div>
    </div>
  );
}
