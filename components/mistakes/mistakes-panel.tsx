"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ChevronDown, ChevronRight, Link2, Loader2, Plus, Trash2 } from "lucide-react";
import { dateKeyInBusinessTZ, formatDate } from "@/lib/date";
import { causeLabel, MISTAKE_CAUSES, MISTAKE_DESCRIPTION_MAX, MISTAKE_STATUSES, mistakeStatusLabel } from "@/lib/mistake-raise";
import {
  buildManualLine,
  buildRecovery,
  costKindLabel,
  costLine,
  COST_KINDS,
  linesByMistake,
  RECOVERY_SOURCES,
  SOURCE_LABELS,
  type CostSources,
  type ManualLineForm,
  type MistakeCostLine,
  type RecoveryForm,
} from "@/lib/mistake-costs";
import { loadCostSources, loadMistakes, withMoney, type MistakeWithMoney, type SourceInfo, type TrackingMode } from "@/lib/mistakes-data";
import { LinkCostDialog } from "./link-cost-dialog";

// The office's mistake review (Justin, 25 Nov 2026 — "crew raise, office
// costs"): every mistake with what it cost — LINKED lines (costs the CRM
// already holds: time, expenses, supplier POs, equipment, Day Works; already
// in the job's cost) and MANUAL lines (only these add cost) — the recovery
// (supplier credit / builder recharge / insurance, claimed and received), whose
// mistake it was (admin only), and its status open → costed → closed.
//
// Two places: the job's Purchase Orders tab (one job's mistakes) and Reports →
// Mistakes (every mistake not closed, jobs and no job). Office/admin only —
// every write goes from the browser as the caller and RLS decides (0119 (a draft, not applied yet):
// office/admin for mistakes and cost lines, admin for whose mistake).

export interface PanelStaff {
  id: string;
  full_name: string | null;
}
export interface PanelLine {
  id: string;
  name: string;
  po_number?: string | null;
}

interface Props {
  /** One job's mistakes; omitted = every mistake not closed (the review). */
  jobId?: string;
  /** The job's PO lines (job mode). */
  costCenters?: PanelLine[];
  staff: PanelStaff[];
  isAdmin: boolean;
  /** Shown when there is nothing yet (job mode). */
  emptyText?: string;
  /** Bumped by the parent to reload (e.g. after Log mistake). */
  reloadKey?: number;
  /** Told what mode the database is in (so the parent can fall back to 0115's card). */
  onMode?: (mode: TrackingMode) => void;
}

interface Lookups {
  categories: { id: string; name: string; is_active: boolean }[];
  centres: { id: string; name: string }[];
  suppliers: { id: string; name: string }[];
  jobs: Map<string, { job_number: number; title: string }>;
  lineNames: Map<string, string>;
  photos: Map<string, { path: string; url: string | null }[]>;
  responsibility: Map<string, { staff_id: string; note: string | null }>;
}

const money = (n: number) => `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const selectClass = "h-9 w-full rounded-md border border-slate-200 bg-white px-2 text-sm text-slate-700";
const STATUS_TONE: Record<string, string> = {
  open: "bg-amber-100 text-amber-800",
  costed: "bg-blue-100 text-blue-800",
  closed: "bg-slate-100 text-slate-600",
};

export function MistakesPanel({ jobId, costCenters = [], staff, isAdmin, emptyText, reloadKey = 0, onMode }: Props) {
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<TrackingMode>("tracking");
  const [loadError, setLoadError] = useState(false);
  const [mistakes, setMistakes] = useState<MistakeWithMoney[]>([]);
  const [lines, setLines] = useState<MistakeCostLine[]>([]);
  const [sources, setSources] = useState<CostSources | null>(null);
  const [info, setInfo] = useState<Map<string, SourceInfo>>(new Map());
  const [lookups, setLookups] = useState<Lookups | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const staffNames = useMemo(() => new Map(staff.map((s) => [s.id, s.full_name ?? "Staff member"])), [staff]);

  useEffect(() => {
    let live = true;
    const supabase = createClient();
    (async () => {
      const loaded = await loadMistakes(supabase, jobId ? { jobId } : { openOnly: true });
      if (!live) return;
      setMode(loaded.mode);
      onMode?.(loaded.mode);
      if (loaded.error) {
        console.error("mistakes load failed:", loaded.error);
        setLoadError(true);
        setLoading(false);
        return;
      }
      try {
        const { sources: src, info: inf } = await loadCostSources(supabase, loaded.lines, { withRates: isAdmin, staffNames });
        const ids = loaded.mistakes.map((m) => m.id);
        const jobIds = [...new Set(loaded.mistakes.map((m) => m.job_id).filter((x): x is string => !!x))];
        const lineIds = [...new Set(loaded.mistakes.map((m) => m.cost_center_id).filter((x): x is string => !!x))];
        const tracking = loaded.mode === "tracking";
        const [cats, centres, sups, jobs, lineRows, photoRows, resp] = await Promise.all([
          tracking ? supabase.from("mistake_categories").select("id, name, is_active").order("sort_order").order("name") : Promise.resolve({ data: [] }),
          supabase.from("cost_centres").select("id, name").order("sort_order").order("name"),
          tracking ? supabase.from("suppliers").select("id, name").eq("is_active", true).order("name") : Promise.resolve({ data: [] }),
          !jobId && jobIds.length ? supabase.from("jobs").select("id, job_number, title").in("id", jobIds.slice(0, 300)) : Promise.resolve({ data: [] }),
          !jobId && lineIds.length ? supabase.from("po_cost_centers").select("id, name").in("id", lineIds.slice(0, 300)) : Promise.resolve({ data: [] }),
          tracking && ids.length ? supabase.from("mistake_photos").select("mistake_id, storage_path").in("mistake_id", ids.slice(0, 300)) : Promise.resolve({ data: [] }),
          tracking && isAdmin && ids.length ? supabase.from("mistake_responsibility").select("mistake_id, staff_id, note").in("mistake_id", ids.slice(0, 300)) : Promise.resolve({ data: [] }),
        ]);
        const photoList = (photoRows.data ?? []) as { mistake_id: string; storage_path: string }[];
        const signed = photoList.length
          ? await supabase.storage.from("job-photos").createSignedUrls(photoList.map((p) => p.storage_path), 3600)
          : { data: [] };
        const urlByPath = new Map((signed.data ?? []).map((s) => [s.path ?? "", s.signedUrl ?? null]));
        const photos = new Map<string, { path: string; url: string | null }[]>();
        for (const p of photoList) (photos.get(p.mistake_id) ?? photos.set(p.mistake_id, []).get(p.mistake_id)!).push({ path: p.storage_path, url: urlByPath.get(p.storage_path) ?? null });
        if (!live) return;
        setLines(loaded.lines);
        setSources(src);
        setInfo(inf);
        setMistakes(
          withMoney(loaded.mistakes, loaded.lines, src).sort((a, b) => b.occurred_on.localeCompare(a.occurred_on) || b.created_at.localeCompare(a.created_at))
        );
        setLookups({
          categories: (cats.data ?? []) as Lookups["categories"],
          centres: (centres.data ?? []) as Lookups["centres"],
          suppliers: (sups.data ?? []) as Lookups["suppliers"],
          jobs: new Map(((jobs.data ?? []) as { id: string; job_number: number; title: string }[]).map((j) => [j.id, j])),
          lineNames: new Map([
            ...costCenters.map((c) => [c.id, c.po_number ? `${c.name} (PO ${c.po_number})` : c.name] as [string, string]),
            ...((lineRows.data ?? []) as { id: string; name: string }[]).map((l) => [l.id, l.name] as [string, string]),
          ]),
          photos,
          responsibility: new Map(((resp.data ?? []) as { mistake_id: string; staff_id: string; note: string | null }[]).map((r) => [r.mistake_id, r])),
        });
        setLoadError(false);
      } catch (err) {
        console.error("mistake costs load failed:", err);
        if (live) setLoadError(true);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => {
      live = false;
    };
    // staffNames/costCenters/onMode are stable enough for a reload trigger; tick and reloadKey drive reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, isAdmin, tick, reloadKey]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const byMistake = useMemo(() => linesByMistake(lines), [lines]);

  if (loading) return <p className="text-sm text-slate-400">Loading…</p>;
  if (mode === "missing") return <p className="text-sm text-slate-500">Mistake tracking isn&apos;t switched on yet.</p>;
  if (mode === "legacy") {
    return <p className="text-sm text-slate-500">Mistake tracking (categories, linked costs, recovery) needs the 0119 database update applied.</p>;
  }
  if (loadError) return <p className="text-sm text-red-600">Couldn&apos;t load the mistakes. Refresh to try again.</p>;
  if (mistakes.length === 0) return <p className="text-sm text-slate-400">{emptyText ?? "No open mistakes."}</p>;

  const total = mistakes.reduce(
    (s, m) => ({ gross: s.gross + m.money.gross, net: s.net + m.money.net, manual: s.manual + m.money.manual, recovered: s.recovered + m.money.recovered }),
    { gross: 0, net: 0, manual: 0, recovered: 0 }
  );

  return (
    <div className="space-y-2">
      {mistakes.map((m) => (
        <MistakeItem
          key={m.id}
          m={m}
          lines={byMistake.get(m.id) ?? []}
          sources={sources!}
          info={info}
          lookups={lookups!}
          staff={staff}
          staffNames={staffNames}
          isAdmin={isAdmin}
          showJob={!jobId}
          costCenters={jobId ? costCenters : []}
          open={expanded === m.id}
          onToggle={() => setExpanded((x) => (x === m.id ? null : m.id))}
          onChanged={reload}
        />
      ))}
      <div className="flex flex-wrap justify-end gap-x-4 gap-y-1 pt-1 text-xs text-slate-600">
        <span>{mistakes.length} mistake{mistakes.length === 1 ? "" : "s"}</span>
        <span>Cost {money(total.gross)}</span>
        <span>of which new cost (manual) {money(total.manual)}</span>
        <span>Recovered {money(total.recovered)}</span>
        <span className="font-semibold text-red-600">Net {money(total.net)}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface ItemProps {
  m: MistakeWithMoney;
  lines: MistakeCostLine[];
  sources: CostSources;
  info: Map<string, SourceInfo>;
  lookups: Lookups;
  staff: PanelStaff[];
  staffNames: Map<string, string>;
  isAdmin: boolean;
  showJob: boolean;
  costCenters: PanelLine[];
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
}

function MistakeItem({ m, lines, sources, info, lookups, staff, staffNames, isAdmin, showJob, costCenters, open, onToggle, onChanged }: ItemProps) {
  const category = lookups.categories.find((c) => c.id === m.category_id)?.name ?? "Uncategorised";
  const stage = m.cost_center_id ? lookups.lineNames.get(m.cost_center_id) ?? "Cost centre" : null;
  const centre = lookups.centres.find((c) => c.id === m.cost_centre_id)?.name ?? null;
  const job = m.job_id ? lookups.jobs.get(m.job_id) : null;

  return (
    <div className="rounded-lg border border-slate-200">
      <button type="button" onClick={onToggle} className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-slate-50">
        {open ? <ChevronDown className="w-4 h-4 mt-0.5 text-slate-400" /> : <ChevronRight className="w-4 h-4 mt-0.5 text-slate-400" />}
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
            <span className="font-medium text-slate-800">{category}</span>
            <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${STATUS_TONE[m.status] ?? STATUS_TONE.open}`}>{mistakeStatusLabel(m.status)}</span>
            <span className="text-xs text-slate-500">
              {formatDate(m.occurred_on, { day: "numeric", month: "short", year: "numeric" })}
              {stage ? ` · ${stage}` : centre ? ` · ${centre}` : ""}
              {m.cause_code ? ` · ${causeLabel(m.cause_code)}` : ""}
              {m.raised_by ? ` · raised by ${staffNames.get(m.raised_by) ?? "staff member"}` : ""}
            </span>
          </div>
          {showJob && (
            <p className="text-xs text-slate-500">
              {m.job_id ? (
                <Link href={`/dashboard/jobs/${m.job_id}?tab=po`} className="hover:underline" onClick={(e) => e.stopPropagation()}>
                  {job ? `#${job.job_number} — ${job.title}` : "Open job"}
                </Link>
              ) : (
                "No job"
              )}
            </p>
          )}
          <p className="text-sm text-slate-700 line-clamp-2 whitespace-pre-wrap">{m.description}</p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-sm font-semibold text-red-600">{money(m.money.net)}</div>
          {m.money.recovered > 0 && <div className="text-[11px] text-emerald-700">−{money(m.money.recovered)} back</div>}
          {lines.length === 0 && <div className="text-[11px] text-amber-700">not costed</div>}
        </div>
      </button>
      {open && (
        <div className="border-t border-slate-100 px-3 py-3 space-y-4">
          <HeaderEditor m={m} lookups={lookups} costCenters={costCenters} onChanged={onChanged} />
          {(lookups.photos.get(m.id) ?? []).length > 0 && (
            <div className="flex flex-wrap gap-2">
              {(lookups.photos.get(m.id) ?? []).map((p) =>
                p.url ? (
                  <a key={p.path} href={p.url} target="_blank" rel="noreferrer">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.url} alt="Mistake photo" className="h-20 w-20 rounded object-cover border border-slate-200" loading="lazy" />
                  </a>
                ) : null
              )}
            </div>
          )}
          <CostLines m={m} lines={lines} sources={sources} info={info} onChanged={onChanged} />
          <RecoveryEditor m={m} onChanged={onChanged} />
          {isAdmin && <ResponsibilityEditor m={m} staff={staff} current={lookups.responsibility.get(m.id) ?? null} onChanged={onChanged} />}
          <StatusBar m={m} hasLines={lines.length > 0} onChanged={onChanged} />
        </div>
      )}
    </div>
  );
}

function HeaderEditor({ m, lookups, costCenters, onChanged }: { m: MistakeWithMoney; lookups: Lookups; costCenters: PanelLine[]; onChanged: () => void }) {
  const [form, setForm] = useState({
    category_id: m.category_id ?? "",
    cause_code: m.cause_code ?? "",
    cause: m.cause ?? "",
    cost_center_id: m.cost_center_id ?? "",
    cost_centre_id: m.cost_centre_id ?? "",
    supplier_id: m.supplier_id ?? "",
    occurred_on: m.occurred_on,
    description: m.description,
  });
  const [saving, setSaving] = useState(false);
  const dirty =
    form.category_id !== (m.category_id ?? "") ||
    form.cause_code !== (m.cause_code ?? "") ||
    form.cause !== (m.cause ?? "") ||
    form.cost_center_id !== (m.cost_center_id ?? "") ||
    form.cost_centre_id !== (m.cost_centre_id ?? "") ||
    form.supplier_id !== (m.supplier_id ?? "") ||
    form.occurred_on !== m.occurred_on ||
    form.description !== m.description;

  async function save() {
    const description = form.description.trim();
    if (!description || description.length > MISTAKE_DESCRIPTION_MAX) return toast.error("Say what went wrong (up to 2000 characters).");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.occurred_on)) return toast.error("Enter the date of the mistake.");
    if (!m.job_id && !form.cost_centre_id) return toast.error("Pick the company cost centre.");
    if (form.cause.length > 500) return toast.error("Keep the cause notes under 500 characters.");
    setSaving(true);
    const { error } = await createClient()
      .from("job_mistakes")
      .update({
        category_id: form.category_id || null,
        cause_code: form.cause_code || null,
        cause: form.cause.trim() || null,
        cost_center_id: m.job_id ? form.cost_center_id || null : null,
        // On a job the company cost centre follows the PO line (the database sets it).
        ...(m.job_id && form.cost_center_id ? {} : { cost_centre_id: form.cost_centre_id || null }),
        supplier_id: form.supplier_id || null,
        occurred_on: form.occurred_on,
        description,
      })
      .eq("id", m.id);
    setSaving(false);
    if (error) {
      console.error("mistake update failed:", error.message);
      return toast.error(error.code === "23514" ? "That cost centre isn't on this job." : "Couldn't save the mistake. Try again.");
    }
    toast.success("Mistake saved");
    onChanged();
  }

  async function remove() {
    if (!window.confirm("Delete this mistake and its cost lines? Linked costs stay on the job; only the link goes.")) return;
    const { error, count } = await createClient().from("job_mistakes").delete({ count: "exact" }).eq("id", m.id);
    if (error || count === 0) {
      if (error) console.error("mistake delete failed:", error.message);
      return toast.error("Couldn't delete the mistake.");
    }
    toast.success("Mistake deleted");
    onChanged();
  }

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">Category</Label>
          <select className={selectClass} value={form.category_id} onChange={set("category_id")}>
            <option value="">Uncategorised</option>
            {lookups.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.is_active ? "" : " (retired)"}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Cause</Label>
          <select className={selectClass} value={form.cause_code} onChange={set("cause_code")}>
            <option value="">Not said</option>
            {MISTAKE_CAUSES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Date</Label>
          <Input type="date" value={form.occurred_on} onChange={set("occurred_on")} />
        </div>
        {m.job_id ? (
          <div className="space-y-1">
            <Label className="text-xs">Stage / PO line</Label>
            <select className={selectClass} value={form.cost_center_id} onChange={set("cost_center_id")}>
              <option value="">Not tagged</option>
              {(costCenters.length ? costCenters : m.cost_center_id ? [{ id: m.cost_center_id, name: lookups.lineNames.get(m.cost_center_id) ?? "Cost centre" }] : []).map((c) => (
                <option key={c.id} value={c.id}>
                  {"po_number" in c && c.po_number ? `${c.name} (PO ${c.po_number})` : c.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        {(!m.job_id || !form.cost_center_id) && (
          <div className="space-y-1">
            <Label className="text-xs">Company cost centre</Label>
            <select className={selectClass} value={form.cost_centre_id} onChange={set("cost_centre_id")}>
              <option value="">{m.job_id ? "Not tagged" : "Pick one…"}</option>
              {lookups.centres.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="space-y-1">
          <Label className="text-xs">Supplier (supply mistakes)</Label>
          <select className={selectClass} value={form.supplier_id} onChange={set("supplier_id")}>
            <option value="">—</option>
            {lookups.suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <Textarea rows={2} maxLength={MISTAKE_DESCRIPTION_MAX} value={form.description} onChange={set("description")} aria-label="What went wrong" />
      <Input maxLength={500} placeholder="Cause notes (optional)" value={form.cause} onChange={set("cause")} />
      <div className="flex justify-between">
        <Button variant="ghost" size="sm" className="text-slate-400 hover:text-red-600 gap-1" onClick={() => void remove()}>
          <Trash2 className="w-3.5 h-3.5" /> Delete mistake
        </Button>
        {dirty && (
          <Button size="sm" onClick={() => void save()} disabled={saving} className="gap-1.5">
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save details
          </Button>
        )}
      </div>
    </div>
  );
}

function CostLines({ m, lines, sources, info, onChanged }: { m: MistakeWithMoney; lines: MistakeCostLine[]; sources: CostSources; info: Map<string, SourceInfo>; onChanged: () => void }) {
  const [form, setForm] = useState<ManualLineForm>({ kind: "material", amount: "", hours: "", note: "" });
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);

  async function addManual() {
    const built = buildManualLine(form);
    if (!built.ok) return toast.error(built.error);
    setSaving(true);
    const { error } = await createClient().from("mistake_cost_lines").insert({ ...built.row, mistake_id: m.id });
    setSaving(false);
    if (error) {
      console.error("mistake cost line insert failed:", error.message);
      return toast.error("Couldn't add the cost line.");
    }
    setForm({ kind: "material", amount: "", hours: "", note: "" });
    setAdding(false);
    onChanged();
  }

  async function removeLine(l: MistakeCostLine) {
    if (!window.confirm(l.source === "manual" ? "Remove this cost line?" : "Unlink this cost? The record itself stays on the job.")) return;
    const { error } = await createClient().from("mistake_cost_lines").delete().eq("id", l.id);
    if (error) {
      console.error("mistake cost line delete failed:", error.message);
      return toast.error("Couldn't remove the cost line.");
    }
    onChanged();
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-slate-800">What it cost</h4>
        <div className="flex gap-2">
          {m.job_id && (
            <Button size="sm" variant="outline" className="gap-1" onClick={() => setLinkOpen(true)}>
              <Link2 className="w-3.5 h-3.5" /> Link existing cost
            </Button>
          )}
          <Button size="sm" variant="outline" className="gap-1" onClick={() => setAdding((a) => !a)}>
            <Plus className="w-3.5 h-3.5" /> Manual cost
          </Button>
        </div>
      </div>
      {lines.length === 0 ? (
        <p className="text-xs text-slate-500">
          No cost yet. Link the time, expenses, supplier POs, equipment or Day Works already on the job — they stay counted once — and add a manual
          cost only for what has no record (e.g. a replacement part paid in cash, a subbie&apos;s callout).
        </p>
      ) : (
        <table className="w-full text-sm">
          <tbody className="divide-y divide-slate-100">
            {lines.map((l) => {
              const c = costLine(l, sources);
              const src = l.source_id ? info.get(`${l.source}:${l.source_id}`) : null;
              return (
                <tr key={l.id} className="align-top">
                  <td className="py-1.5 pr-2 text-xs text-slate-500 whitespace-nowrap">{costKindLabel(l.kind)}</td>
                  <td className="py-1.5 pr-2 text-slate-700">
                    <span className="text-xs text-slate-400">{SOURCE_LABELS[l.source as keyof typeof SOURCE_LABELS] ?? l.source}</span>{" "}
                    {src ? (
                      <>
                        {src.title}
                        {src.date ? <span className="text-xs text-slate-400"> · {formatDate(src.date, { day: "numeric", month: "short" })}</span> : null}
                      </>
                    ) : l.source === "manual" ? (
                      l.note ?? ""
                    ) : (
                      <span className="text-amber-700">record no longer there</span>
                    )}
                    {l.source !== "manual" && l.note && <span className="block text-xs text-slate-500">{l.note}</span>}
                    {c.hours != null && <span className="text-xs text-slate-500"> · {c.hours} h</span>}
                  </td>
                  <td className="py-1.5 pr-2 text-right whitespace-nowrap">
                    {c.status === "hidden" ? (
                      <span className="text-xs text-slate-400" title="Labour cost uses payroll rates — admin only">admin sees cost</span>
                    ) : c.status === "unpriced" ? (
                      <span className="text-xs text-amber-700">not priced</span>
                    ) : (
                      <span className={c.linked ? "text-slate-600" : "font-medium text-red-600"}>{money(c.amount)}</span>
                    )}
                    <span className="block text-[10px] text-slate-400">{c.linked ? "already in job cost" : "added cost"}</span>
                  </td>
                  <td className="py-1.5 text-right">
                    <button type="button" aria-label="Remove cost line" className="p-1 text-slate-300 hover:text-red-500" onClick={() => void removeLine(l)}>
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {adding && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 rounded bg-slate-50 p-2">
          <select className={selectClass} value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value }))} aria-label="Kind of cost">
            {COST_KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
          <Input inputMode="decimal" placeholder="Cost ex GST" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} />
          <Input inputMode="decimal" placeholder="Hours (optional)" value={form.hours} onChange={(e) => setForm((f) => ({ ...f, hours: e.target.value }))} />
          <Input placeholder="What for" maxLength={500} value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
          <Button size="sm" onClick={() => void addManual()} disabled={saving}>
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Add"}
          </Button>
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-x-4 text-xs text-slate-600">
        <span>Linked {money(m.money.linked)}</span>
        <span>Manual {money(m.money.manual)}</span>
        <span className="font-medium">Total {money(m.money.gross)}</span>
        {m.money.hiddenHours > 0 && <span className="text-slate-400">+ {m.money.hiddenHours} h labour (admin sees the cost)</span>}
        {m.money.unpriced > 0 && <span className="text-amber-700">{m.money.unpriced} line{m.money.unpriced === 1 ? "" : "s"} not priced</span>}
      </div>
      {m.job_id && <LinkCostDialog open={linkOpen} onOpenChange={setLinkOpen} jobId={m.job_id} mistakeId={m.id} onLinked={onChanged} />}
    </div>
  );
}

function RecoveryEditor({ m, onChanged }: { m: MistakeWithMoney; onChanged: () => void }) {
  const initial: RecoveryForm = {
    source: m.recovery_source ?? "",
    claimed: m.recovery_claimed_ex_gst != null ? String(m.recovery_claimed_ex_gst) : "",
    received: m.recovered_ex_gst != null ? String(m.recovered_ex_gst) : "",
    claimedOn: m.recovery_claimed_on ?? "",
    note: m.recovery_note ?? "",
  };
  const [form, setForm] = useState<RecoveryForm>(initial);
  const [saving, setSaving] = useState(false);
  const dirty = (Object.keys(initial) as (keyof RecoveryForm)[]).some((k) => initial[k] !== form[k]);

  async function save() {
    const built = buildRecovery(form);
    if (!built.ok) return toast.error(built.error);
    setSaving(true);
    const { error } = await createClient().from("job_mistakes").update(built.row).eq("id", m.id);
    setSaving(false);
    if (error) {
      console.error("mistake recovery save failed:", error.message);
      return toast.error("Couldn't save the recovery.");
    }
    toast.success("Recovery saved");
    onChanged();
  }

  return (
    <div className="space-y-2">
      <h4 className="text-sm font-semibold text-slate-800">Money back</h4>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <select className={selectClass} value={form.source} onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))} aria-label="Recovered from">
          <option value="">None</option>
          {RECOVERY_SOURCES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <Input inputMode="decimal" placeholder="Claimed ex GST" value={form.claimed} onChange={(e) => setForm((f) => ({ ...f, claimed: e.target.value }))} />
        <Input inputMode="decimal" placeholder="Received ex GST" value={form.received} onChange={(e) => setForm((f) => ({ ...f, received: e.target.value }))} />
        <Input type="date" aria-label="Claimed on" value={form.claimedOn} onChange={(e) => setForm((f) => ({ ...f, claimedOn: e.target.value }))} />
      </div>
      <Input placeholder="Credit note / claim reference" maxLength={1000} value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
      {dirty && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => void save()} disabled={saving}>
            Save recovery
          </Button>
        </div>
      )}
    </div>
  );
}

function ResponsibilityEditor({ m, staff, current, onChanged }: { m: MistakeWithMoney; staff: PanelStaff[]; current: { staff_id: string; note: string | null } | null; onChanged: () => void }) {
  const [staffId, setStaffId] = useState(current?.staff_id ?? "");
  const [note, setNote] = useState(current?.note ?? "");
  const dirty = staffId !== (current?.staff_id ?? "") || note !== (current?.note ?? "");

  async function save() {
    const supabase = createClient();
    const { error } = staffId
      ? await supabase.from("mistake_responsibility").upsert({ mistake_id: m.id, staff_id: staffId, note: note.trim() || null })
      : await supabase.from("mistake_responsibility").delete().eq("mistake_id", m.id);
    if (error) {
      console.error("mistake responsibility save failed:", error.message);
      return toast.error("Couldn't save whose mistake it was.");
    }
    toast.success("Saved");
    onChanged();
  }

  return (
    <div className="space-y-1">
      <h4 className="text-sm font-semibold text-slate-800">
        Whose mistake <span className="text-xs font-normal text-slate-400">— admin only, never shown to office or crew</span>
      </h4>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <select className={selectClass} value={staffId} onChange={(e) => setStaffId(e.target.value)} aria-label="Whose mistake">
          <option value="">Not recorded</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.full_name ?? "Staff member"}
            </option>
          ))}
        </select>
        <Input className="sm:col-span-2" placeholder="Note (optional)" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {dirty && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => void save()}>
            Save
          </Button>
        </div>
      )}
    </div>
  );
}

function StatusBar({ m, hasLines, onChanged }: { m: MistakeWithMoney; hasLines: boolean; onChanged: () => void }) {
  const [saving, setSaving] = useState(false);
  async function setStatus(status: string) {
    if (status === "closed" && !hasLines && !window.confirm("Close this mistake with no cost on it?")) return;
    setSaving(true);
    const { error } = await createClient().from("job_mistakes").update({ status }).eq("id", m.id);
    setSaving(false);
    if (error) {
      console.error("mistake status save failed:", error.message);
      return toast.error("Couldn't change the status.");
    }
    onChanged();
  }
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-2">
      <span className="text-xs text-slate-500 mr-auto">
        Status: {mistakeStatusLabel(m.status)}
        {m.closed_at ? ` · closed ${formatDate(m.closed_at, { day: "numeric", month: "short" })}` : ""}
      </span>
      {MISTAKE_STATUSES.filter((s) => s.value !== m.status).map((s) => (
        <Button key={s.value} size="sm" variant={s.value === "closed" ? "default" : "outline"} disabled={saving} onClick={() => void setStatus(s.value)}>
          {s.value === "open" ? "Reopen" : s.value === "costed" ? "Mark costed" : "Close"}
        </Button>
      ))}
    </div>
  );
}

/** Log a mistake with no job (truck or plant overhead) — office, from the Mistakes report. */
export function LogJoblessMistake({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [cats, setCats] = useState<{ id: string; name: string }[]>([]);
  const [centres, setCentres] = useState<{ id: string; name: string }[]>([]);
  const [form, setForm] = useState({ category_id: "", cost_centre_id: "", cause_code: "", description: "", occurred_on: dateKeyInBusinessTZ(new Date()) });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    const supabase = createClient();
    void Promise.all([
      supabase.from("mistake_categories").select("id, name").eq("is_active", true).order("sort_order"),
      supabase.from("cost_centres").select("id, name").eq("is_active", true).order("sort_order"),
    ]).then(([c, cc]) => {
      setCats((c.data ?? []) as never[]);
      setCentres((cc.data ?? []) as never[]);
    });
  }, [open]);

  async function save() {
    if (!form.category_id) return toast.error("Pick what kind of mistake it was.");
    if (!form.cost_centre_id) return toast.error("Pick the company cost centre.");
    const description = form.description.trim();
    if (!description) return toast.error("Say what went wrong.");
    if (form.occurred_on > dateKeyInBusinessTZ(new Date())) return toast.error("The date can't be in the future.");
    setSaving(true);
    const { error } = await createClient()
      .from("job_mistakes")
      .insert({ job_id: null, category_id: form.category_id, cost_centre_id: form.cost_centre_id, cause_code: form.cause_code || null, description, occurred_on: form.occurred_on });
    setSaving(false);
    if (error) {
      console.error("jobless mistake insert failed:", error.message);
      return toast.error("Couldn't log the mistake.");
    }
    toast.success("Mistake logged — open it below to add its cost.");
    setOpen(false);
    setForm((f) => ({ ...f, description: "" }));
    onSaved();
  }

  if (!open) {
    return (
      <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setOpen(true)}>
        <Plus className="w-3.5 h-3.5" /> Log a mistake with no job
      </Button>
    );
  }
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
      <p className="text-xs text-slate-500">For overhead mistakes not on a job — a truck sent empty, plant hired for nothing. It goes against a company cost centre.</p>
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
        <select className={selectClass} value={form.category_id} onChange={(e) => setForm((f) => ({ ...f, category_id: e.target.value }))} aria-label="Category">
          <option value="">Category…</option>
          {cats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select className={selectClass} value={form.cost_centre_id} onChange={(e) => setForm((f) => ({ ...f, cost_centre_id: e.target.value }))} aria-label="Company cost centre">
          <option value="">Cost centre…</option>
          {centres.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select className={selectClass} value={form.cause_code} onChange={(e) => setForm((f) => ({ ...f, cause_code: e.target.value }))} aria-label="Cause">
          <option value="">Cause…</option>
          {MISTAKE_CAUSES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <Input type="date" value={form.occurred_on} onChange={(e) => setForm((f) => ({ ...f, occurred_on: e.target.value }))} aria-label="Date" />
      </div>
      <Textarea rows={2} maxLength={MISTAKE_DESCRIPTION_MAX} placeholder="What went wrong" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={saving}>
          Log mistake
        </Button>
      </div>
    </div>
  );
}
