import Link from "next/link";
import { anchorForDateKey, formatDate } from "@/lib/date";
import { invoiceHref, KIND_LABELS, UNBILLED_KINDS, type UnbilledJob, type UnbilledKind } from "@/lib/unbilled-work";
import { Card, CardContent } from "@/components/ui/card";
import { AlertTriangle } from "lucide-react";

// One job on Reports -> Unbilled work: its unbilled items by kind, each with
// where it is invoiced. Office/admin page only (it shows amounts).

const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (key: string) => (key ? formatDate(anchorForDateKey(key), { day: "numeric", month: "short", year: "numeric" }) : "—");

const LINK_TEXT: Record<UnbilledKind, string> = {
  dayworks: "Invoice Day Works",
  load: "Invoice Day Works",
  variation: "Variations tab",
  hours: "New invoice",
  po: "Invoice this PO",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  scheduled: "Scheduled",
  in_progress: "In progress",
  on_hold: "On hold",
  completed: "Completed",
  cancelled: "Cancelled",
};

export function UnbilledJobCard({ job }: { job: UnbilledJob }) {
  const kinds = UNBILLED_KINDS.filter((k) => job.items.some((i) => i.kind === k));
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Link href={`/dashboard/jobs/${job.jobId}`} prefetch={false} className="font-semibold text-slate-900 hover:underline">
              {job.jobNumber != null ? `#${job.jobNumber} — ` : ""}
              {job.title}
            </Link>
            <p className="text-xs text-slate-500">
              {job.customer}
              {job.status ? ` · ${STATUS_LABEL[job.status] ?? job.status}` : ""}
              {job.oldestDate ? ` · oldest ${day(job.oldestDate)} (${job.ageDays} day${job.ageDays === 1 ? "" : "s"})` : ""}
            </p>
          </div>
          <div className="text-right">
            <p className="text-lg font-bold text-slate-900 tabular-nums">{money(job.total)}</p>
            {job.hours > 0 && <p className="text-xs text-slate-500">+ {job.hours.toFixed(2)} h not yet priced</p>}
            {job.unpriced > 0 && (
              <p className="text-xs text-amber-700">
                + {job.unpriced} item{job.unpriced === 1 ? "" : "s"} not priced
              </p>
            )}
          </div>
        </div>
        <div className="space-y-3">
          {kinds.map((kind) => {
            const list = job.items.filter((i) => i.kind === kind);
            const sub = list.reduce((s, i) => s + (i.amount ?? 0), 0);
            const href = invoiceHref(kind, job.jobId, list[0].id);
            return (
              <div key={kind} className="rounded-md border border-slate-100">
                <div className="flex flex-wrap items-center justify-between gap-2 bg-slate-50 px-3 py-1.5 text-xs">
                  <span className="font-semibold text-slate-700">
                    {KIND_LABELS[kind]} ({list.length})
                  </span>
                  <span className="flex items-center gap-3">
                    {kind !== "hours" && <span className="font-medium tabular-nums text-slate-700">{money(Math.round(sub * 100) / 100)}</span>}
                    {kind !== "po" && (
                      <Link href={href} prefetch={false} className="text-blue-600 hover:underline">
                        {LINK_TEXT[kind]} →
                      </Link>
                    )}
                  </span>
                </div>
                <ul className="divide-y divide-slate-100 text-sm">
                  {list.map((i) => (
                    <li key={`${i.kind}-${i.id}`} className="flex flex-wrap items-start justify-between gap-2 px-3 py-1.5">
                      <div className="min-w-0">
                        <span className="text-slate-800">{i.label}</span>
                        <span className="ml-2 text-xs text-slate-400">{day(i.date)}</span>
                        {i.detail && <p className="text-xs text-slate-500">{i.detail}</p>}
                        {i.problem && (
                          <p className="text-xs text-amber-700">
                            <AlertTriangle className="inline w-3 h-3 mr-1 -mt-0.5" />
                            Not priced: {i.problem}
                          </p>
                        )}
                        {i.kind === "hours" && <p className="text-xs text-slate-400">Priced on the invoice with &ldquo;Apply hourly rate&rdquo;.</p>}
                      </div>
                      <div className="flex items-center gap-3 text-right">
                        <span className="tabular-nums text-slate-800">
                          {i.kind === "hours" ? `${(i.hours ?? 0).toFixed(2)} h` : i.amount == null ? <span className="text-amber-700">not priced</span> : money(i.amount)}
                        </span>
                        {i.kind === "po" && (
                          <Link href={invoiceHref("po", job.jobId, i.id)} prefetch={false} className="text-xs text-blue-600 hover:underline">
                            {LINK_TEXT.po} →
                          </Link>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
