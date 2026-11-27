"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Mail } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Supplier invoices from Gmail (0124, drafted), under Settings → Google Calendar:
 * whether the Google connection may read mail, and the label the import
 * reads. Only label_name is the office's to set (column grant + RLS); the run
 * state is the import's own.
 */
export function GmailInvoiceSetting({
  state,
  viewerId,
}: {
  state: { label_name: string; gmail_allowed: boolean | null; last_poll_at: string | null; last_error: string | null } | null;
  viewerId: string | null;
}) {
  const [label, setLabel] = useState(state?.label_name ?? "");
  const [saving, setSaving] = useState(false);

  if (!state) {
    return (
      <p className="text-xs text-slate-400 flex items-center gap-1.5">
        <Mail className="w-3.5 h-3.5" /> Reading supplier invoices from Gmail isn&apos;t switched on yet.
      </p>
    );
  }

  async function save() {
    const next = label.trim();
    if (!next) { toast.error("Type the Gmail label's name"); return; }
    setSaving(true);
    const { error, count } = await createClient()
      .from("gmail_invoice_settings")
      .update({ label_name: next, updated_at: new Date().toISOString(), updated_by: viewerId }, { count: "exact" })
      .eq("id", true);
    setSaving(false);
    if (error || count === 0) { toast.error("Couldn't save the label"); return; }
    toast.success(`Supplier invoices will be read from the "${next}" label`);
  }

  return (
    <div className="space-y-2 border-t border-slate-100 pt-3 text-sm">
      <p className="font-medium text-slate-800 flex items-center gap-1.5"><Mail className="w-4 h-4 text-blue-600" /> Supplier invoices from Gmail</p>
      {state.gmail_allowed === false ? (
        <p className="flex items-center gap-1.5 text-amber-700 text-xs">
          <AlertTriangle className="w-3.5 h-3.5" /> Reconnect Google to allow reading supplier invoices (Reconnect, above — an admin).
        </p>
      ) : state.gmail_allowed ? (
        <p className="flex items-center gap-1.5 text-green-700 text-xs"><CheckCircle2 className="w-3.5 h-3.5" /> Gmail reading is allowed.</p>
      ) : (
        <p className="text-xs text-slate-500">Not checked yet — the first hourly run will tell. If Google was connected before 27 Nov 2026, reconnect it to allow reading mail.</p>
      )}
      {state.last_error && state.gmail_allowed !== false && <p className="text-xs text-amber-700">{state.last_error}</p>}
      <div className="flex items-center gap-2">
        <Input value={label} onChange={(e) => setLabel(e.target.value)} className="h-8 max-w-xs text-xs" maxLength={100} aria-label="Gmail label" />
        <Button size="sm" variant="outline" className="h-8 text-xs" onClick={save} disabled={saving || label.trim() === state.label_name}>
          {saving ? "Saving…" : "Save label"}
        </Button>
      </div>
      <p className="text-xs text-slate-400">
        Bills in this label are read every hour and put on their supplier PO for checking — see{" "}
        <Link href="/dashboard/supplier-pos" className="text-blue-600 hover:underline">Supplier POs</Link>.
      </p>
    </div>
  );
}
