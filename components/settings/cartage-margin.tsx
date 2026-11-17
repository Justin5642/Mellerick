"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// The company margin on quarry product and tip fees charged on as Truck loads
// (0111, drafted — not applied yet). Read and saved through /api/settings/cartage-margin (office/admin).

export function CartageMarginSetting() {
  const [value, setValue] = useState("");
  const [state, setState] = useState<"loading" | "ready" | "not-ready" | "error">("loading");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    fetch("/api/settings/cartage-margin")
      .then((r) => r.json().then((b) => ({ ok: r.ok, b })))
      .then(({ ok, b }) => {
        if (!live) return;
        if (!ok) return setState("error");
        if (!b.ready) return setState("not-ready");
        setValue(String(b.marginPct));
        setState("ready");
      })
      .catch(() => live && setState("error"));
    return () => {
      live = false;
    };
  }, []);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/settings/cartage-margin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marginPct: value.trim() }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return toast.error(body.error ?? "Couldn't save the margin.");
      setValue(String(body.marginPct));
      toast.success("Saved");
    } catch {
      toast.error("Couldn't save the margin.");
    } finally {
      setSaving(false);
    }
  }

  if (state === "loading") return <p className="text-sm text-slate-400">Loading…</p>;
  if (state === "not-ready") return <p className="text-sm text-slate-500">Truck loads aren&apos;t switched on yet — the database update for them still has to be applied.</p>;
  if (state === "error") return <p className="text-sm text-red-600">Couldn&apos;t load the margin.</p>;
  return (
    <div className="space-y-1.5">
      <Label htmlFor="cartageMargin">Margin on quarry product and tip fees (%)</Label>
      <p className="text-xs text-slate-500">
        Added to the docket cost (ex GST) of extra truck loads before km and per-tonne cartage. The office can override it on a single load.
      </p>
      <div className="flex gap-2 max-w-xs">
        <Input id="cartageMargin" type="number" inputMode="decimal" min={0} max={1000} step={0.5} value={value} onChange={(e) => setValue(e.target.value)} />
        <Button variant="outline" size="sm" onClick={() => void save()} disabled={saving}>
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}
