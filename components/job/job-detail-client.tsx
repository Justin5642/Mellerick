"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Briefcase, FileText, Image, List, MessageSquare, PenLine, ClipboardList, Clock, Receipt, GitPullRequestArrow, DollarSign, Truck, TrendingUp, Trash2, CalendarClock } from "lucide-react";
import Link from "next/link";
import { JobOverview } from "./job-overview";
import { DeleteJobDialog } from "./delete-job-dialog";
import { JobHoursScoreboard } from "./job-hours-scoreboard";
import { JobTodoControl } from "./job-todo-control";
import { sumAllocatedHours } from "@/lib/hours-scoreboard";

// Overview is the default tab, so it ships in the page bundle. Every other
// tab is its own chunk, fetched the first time it is shown — Base UI only
// mounts the active panel, so an unopened tab costs nothing. SSR stays on so
// a `?tab=` deep link still renders that tab in the server HTML.
function TabLoading() {
  return <div className="p-6 text-sm text-slate-400">Loading...</div>;
}
const JobDocuments = dynamic(() => import("./job-documents").then((m) => m.JobDocuments), { loading: TabLoading });
const JobPhotos = dynamic(() => import("./job-photos").then((m) => m.JobPhotos), { loading: TabLoading });
const JobLineItems = dynamic(() => import("./job-line-items").then((m) => m.JobLineItems), { loading: TabLoading });
const JobNotes = dynamic(() => import("./job-notes").then((m) => m.JobNotes), { loading: TabLoading });
const JobSignature = dynamic(() => import("./job-signature").then((m) => m.JobSignature), { loading: TabLoading });
const JobPO = dynamic(() => import("./job-po").then((m) => m.JobPO), { loading: TabLoading });
const JobTime = dynamic(() => import("./job-time").then((m) => m.JobTime), { loading: TabLoading });
const JobVariations = dynamic(() => import("./job-variations").then((m) => m.JobVariations), { loading: TabLoading });
const JobExpenses = dynamic(() => import("./job-expenses").then((m) => m.JobExpenses), { loading: TabLoading });
const JobEquipment = dynamic(() => import("./job-equipment").then((m) => m.JobEquipment), { loading: TabLoading });
const JobProfitability = dynamic(() => import("./job-profitability").then((m) => m.JobProfitability), { loading: TabLoading });
// The schedule wizard is mounted on first open (it re-seeds itself on every
// open anyway), so its code is only fetched when someone clicks Schedule Job.
const ScheduleJobDialog = dynamic(() => import("./schedule-job-dialog").then((m) => m.ScheduleJobDialog), { ssr: false });
import { jobStatusColors, jobPriorityColors } from "@/lib/badge-colors";
import { getCurrentStageNote, getJobStageLabel } from "@/lib/job-stages";

// Kept in sync with the `value`s in the TabsTrigger list below — used to
// validate a `?tab=` query param (e.g. from the Approvals page's "Price &
// review" link) before trusting it as the initial active tab.
const TAB_VALUES = ["overview", "po", "time", "variations", "expenses", "equipment", "costing", "documents", "photos", "items", "notes", "signature"];

// Reference catalogs (pricing items, variation types, equipment) are only
// read by one or two tabs, so the server page no longer loads them up front.
// This fetches one the first time a tab that needs it is shown, through the
// browser client — same session, same RLS, same query the server ran — and
// keeps it for the life of the page so switching tabs doesn't refetch.
// null = not loaded yet. A failed read resolves to [] exactly as the
// server's `data ?? []` did.
function useCatalogOnFirstUse<T>(wanted: boolean, load: () => PromiseLike<{ data: T[] | null }>): T[] | null {
  const [rows, setRows] = useState<T[] | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (!wanted || started.current) return;
    started.current = true;
    load().then(
      ({ data }) => setRows(data ?? []),
      () => setRows([])
    );
    // load is a fresh closure each render; `wanted` flipping is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted]);
  return rows;
}

interface Props {
  job: any;
  currentUserId: string;
  photos: any[];
  documents: any[];
  notes: any[];
  stageNotes: any[];
  lineItems: any[];
  staff: any[];
  purchaseOrders: any[];
  vendorOrders: any[];
  timeEntries: any[];
  variations: any[];
  expenses: any[];
  equipmentUsage: any[];
  isAdmin: boolean;
  // office or admin — may hide documents from technicians (Office only).
  isOffice: boolean;
  // Technicians only: allocated hours from the money-free purchase_orders_public
  // view, for the Overview Hours Scoreboard. Always 0/null for office/admin.
  techAllocatedHours: number;
  techAllocatedHoursError: string | null;
  staffCostProfiles: any[];
  jobInvoices: any[];
  minMarginPct: number;
  currentAssignedIds: string[];
}

export function JobDetailClient({ job, currentUserId, photos: initialPhotos, documents: initialDocuments, notes: initialNotes, stageNotes: initialStageNotes, lineItems: initialLineItems, staff, purchaseOrders: initialPOs, vendorOrders: initialVendorOrders, timeEntries: initialTimeEntries, variations: initialVariations, expenses: initialExpenses, equipmentUsage: initialEquipmentUsage, isAdmin, isOffice, techAllocatedHours, techAllocatedHoursError, staffCostProfiles, jobInvoices, minMarginPct, currentAssignedIds }: Props) {
  // Deep-links like /dashboard/jobs/[id]?tab=variations&variation=[id]
  // (used by the Approvals page's "Price & review" link) land here — read
  // them once on mount so the right tab opens and the right variation is
  // highlighted, instead of always defaulting to Overview.
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get("tab");
  // The PO tab (PO values, cost-centre amounts, vendor orders) is office/admin
  // only — a technician deep-linked to ?tab=po lands on Overview instead.
  const [activeTab, setActiveTab] = useState(
    requestedTab && TAB_VALUES.includes(requestedTab) && (isOffice || requestedTab !== "po") ? requestedTab : "overview"
  );
  const highlightVariationId = searchParams.get("variation");
  const [deleteOpen, setDeleteOpen] = useState(false);
  // `?schedule=1` (the Schedule page's To-do list "Schedule" action) opens the
  // schedule wizard straight away. Office/admin only — the same people that
  // list reaches; a technician following the link just gets the job page.
  const autoOpenSchedule = isOffice && searchParams.get("schedule") === "1";
  const [scheduleOpen, setScheduleOpen] = useState(autoOpenSchedule);
  const [scheduleMounted, setScheduleMounted] = useState(autoOpenSchedule);
  // Drop the param once honoured, so a reload or Back doesn't reopen the wizard.
  useEffect(() => {
    if (!autoOpenSchedule) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("schedule");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, [autoOpenSchedule]);
  const assignedStaff = staff.find((s: any) => s.id === job.assigned_to) ?? null;

  const [photos, setPhotos] = useState(initialPhotos);
  const [documents, setDocuments] = useState(initialDocuments);
  const [notes, setNotes] = useState(initialNotes);
  const [stageNotes, setStageNotes] = useState(initialStageNotes);
  // Most recent stage note across all stages — "where the last person left
  // off" — shown as a header badge so it's visible without opening the Notes
  // tab. Distinct from job.status (whole-job lifecycle) and job.priority.
  const currentStageNote = getCurrentStageNote(stageNotes);
  const [lineItems, setLineItems] = useState(initialLineItems);
  const [purchaseOrders, setPurchaseOrders] = useState(initialPOs);
  const [vendorOrders, setVendorOrders] = useState(initialVendorOrders);
  const [timeEntries, setTimeEntries] = useState(initialTimeEntries);
  const [variations, setVariations] = useState(initialVariations);
  const [expenses, setExpenses] = useState(initialExpenses);
  const [equipmentUsage, setEquipmentUsage] = useState(initialEquipmentUsage);

  const pricingItems = useCatalogOnFirstUse<any>(activeTab === "items", () =>
    createClient().from("pricing_items").select("*").eq("is_active", true).order("category").order("name")
  );
  const variationTypes = useCatalogOnFirstUse<any>(activeTab === "variations", () =>
    createClient().from("variation_types").select("*").eq("is_active", true).order("name")
  );
  // Equipment names and $/hour are part of what the Equipment and Costing
  // tabs draw (not just a picker), so those two tabs wait for it rather than
  // briefly showing "Unknown equipment" or an understated cost.
  const equipmentOptions = useCatalogOnFirstUse<any>(activeTab === "equipment" || (isAdmin && activeTab === "costing"), () =>
    createClient().from("equipment").select("*").eq("is_active", true).order("name")
  );
  // Only "work" entries count against the allocated-hours budget — travel
  // time between jobs is tracked separately and shouldn't eat into it.
  const totalHoursLogged = timeEntries
    .filter((e: any) => e.entry_type !== "travel")
    .reduce((sum: number, e: any) => sum + (e.hours ? Number(e.hours) : 0), 0);

  // Flat list of every cost centre (stage) across all POs on this job, so
  // Expenses and Time can tag against them and the PO tab can show actual
  // spend/hours per stage instead of just per job.
  const costCenters = purchaseOrders.flatMap((po: any) =>
    (po.po_cost_centers ?? []).map((cc: any) => ({ id: cc.id, name: cc.name, code: cc.code, po_number: po.po_number }))
  );

  const unbilledVariations = variations.filter(
    (v: any) => (v.status === "approved" || v.status === "auto_approved") && !v.invoice_id
  );
  const unbilledVariationsTotal = unbilledVariations.reduce((sum: number, v: any) => sum + (Number(v.total_amount) || 0), 0);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="bg-white border-b px-6 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <Link href="/dashboard/jobs">
              <Button variant="ghost" size="sm" className="gap-1.5 text-slate-500 mt-0.5">
                <ArrowLeft className="w-4 h-4" /> Back
              </Button>
            </Link>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl font-bold text-slate-900">#{job.job_number} — {job.title}</h1>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${jobStatusColors[job.status]}`}>
                  {job.status.replace("_", " ")}
                </span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${jobPriorityColors[job.priority]}`}>
                  {job.priority}
                </span>
                {currentStageNote && (
                  <span
                    className="text-xs px-2 py-0.5 rounded-full font-medium bg-cyan-100 text-cyan-800"
                    title={`Last stage note: ${currentStageNote.content}`}
                  >
                    Stage: {getJobStageLabel(currentStageNote.stage)}
                  </span>
                )}
              </div>
              <p className="text-sm text-slate-500 mt-0.5">
                {job.customers?.name}
                {job.sites ? ` · ${job.sites.name}, ${job.sites.suburb}` : ""}
                {""}
              </p>
              <p className="text-xs text-slate-400 mt-1">
                {assignedStaff && job.scheduled_start ? (
                  <>
                    {assignedStaff.full_name} ·{" "}
                    {new Date(job.scheduled_start).toLocaleString("en-AU", {
                      weekday: "short",
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                      timeZone: "Australia/Melbourne",
                    })}
                  </>
                ) : (
                  "Not scheduled"
                )}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* To-do list (office/admin). Absent key = the jobs columns are not
                in this database yet, so the control stays hidden rather than
                offering a write that would fail. */}
            {isOffice && "todo_listed_at" in job && (
              <JobTodoControl
                jobId={job.id}
                currentUserId={currentUserId}
                status={job.status}
                todoListedAt={job.todo_listed_at}
                estimatedHours={job.estimated_hours}
                poAllocatedHours={sumAllocatedHours(purchaseOrders)}
              />
            )}
            <Button size="sm" className="gap-1.5" onClick={() => { setScheduleMounted(true); setScheduleOpen(true); }}>
              <CalendarClock className="w-4 h-4" />
              Schedule Job
            </Button>
            {unbilledVariations.length > 0 && (
              <span
                className="text-xs font-medium px-2.5 py-1 rounded-full bg-orange-100 text-orange-700"
                title="Approved variations not yet added to an invoice"
              >
                {unbilledVariations.length} unbilled variation{unbilledVariations.length === 1 ? "" : "s"} · ${unbilledVariationsTotal.toFixed(2)}
              </span>
            )}
            {job.ready_to_invoice && (
              <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-amber-100 text-amber-700">
                Awaiting Invoice
              </span>
            )}
            {isAdmin && (
              <Button
                variant="ghost" size="sm"
                className="gap-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="w-4 h-4" />Delete
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex-1 overflow-hidden">
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v ?? "overview")} className="h-full flex flex-col">
          <div className="bg-white border-b px-6 overflow-x-auto">
            <TabsList className="h-auto bg-transparent p-0 gap-0 flex w-max min-w-full">
              {[
                { value: "overview", label: "Overview", icon: Briefcase },
                ...(isOffice ? [{ value: "po", label: "Purchase Orders", icon: ClipboardList }] : []),
                { value: "time", label: "Time", icon: Clock },
                { value: "variations", label: "Variations", icon: GitPullRequestArrow },
                { value: "expenses", label: "Expenses", icon: DollarSign },
                { value: "equipment", label: "Equipment", icon: Truck },
                ...(isAdmin ? [{ value: "costing", label: "Costing", icon: TrendingUp }] : []),
                { value: "documents", label: "Documents", icon: FileText },
                { value: "photos", label: "Photos", icon: Image },
                { value: "items", label: "Line Items", icon: List },
                { value: "notes", label: "Notes", icon: MessageSquare },
                { value: "signature", label: "Signature", icon: PenLine },
              ].map(({ value, label, icon: Icon }) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  className="flex items-center gap-1.5 px-4 py-3 rounded-none border-b-2 border-transparent data-[state=active]:border-blue-600 data-[state=active]:text-blue-600 data-[state=active]:bg-transparent text-slate-500 text-sm font-medium transition-colors"
                >
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <div className="flex-1 overflow-y-auto">
            <TabsContent value="overview" className="m-0 h-full">
              {/* Technicians: hours-only scoreboard (no $), same placement as mobile. */}
              {!isOffice && (techAllocatedHours > 0 || techAllocatedHoursError) && (
                <div className="px-6 pt-6">
                  <JobHoursScoreboard
                    jobId={job.id}
                    currentUserId={currentUserId}
                    allocatedHours={techAllocatedHours}
                    loadError={techAllocatedHoursError}
                    timeEntries={timeEntries}
                    overtimeReason={job.overtime_reason}
                    overtimeCategory={job.overtime_category}
                  />
                </div>
              )}
              <JobOverview job={job} staff={staff} />
            </TabsContent>
            {isOffice && (
            <TabsContent value="po" className="m-0 h-full">
              <JobPO
                jobId={job.id}
                pos={purchaseOrders}
                totalHoursLogged={totalHoursLogged}
                onUpdate={setPurchaseOrders}
                overtimeReason={job.overtime_reason}
                overtimeCategory={job.overtime_category}
                expenses={expenses}
                timeEntries={timeEntries}
                vendorOrders={vendorOrders}
                onVendorOrdersUpdate={setVendorOrders}
              />
            </TabsContent>
            )}
            <TabsContent value="time" className="m-0 h-full">
              <JobTime jobId={job.id} currentUserId={currentUserId} timeEntries={timeEntries} pos={purchaseOrders} site={job.sites} costCenters={costCenters} isAdmin={isAdmin} staff={staff} onUpdate={setTimeEntries} scheduledCostCenterId={job.scheduled_cost_center_id} />
            </TabsContent>
            <TabsContent value="variations" className="m-0 h-full">
              <JobVariations jobId={job.id} variations={variations} variationTypes={variationTypes} currentUserId={currentUserId} onUpdate={setVariations} highlightVariationId={highlightVariationId} />
            </TabsContent>
            <TabsContent value="expenses" className="m-0 h-full">
              <JobExpenses jobId={job.id} jobNumber={job.job_number} expenses={expenses} onUpdate={setExpenses} currentUserId={currentUserId} costCenters={costCenters} />
            </TabsContent>
            <TabsContent value="equipment" className="m-0 h-full">
              {equipmentOptions ? (
                <JobEquipment jobId={job.id} usage={equipmentUsage} equipmentOptions={equipmentOptions} onUpdate={setEquipmentUsage} />
              ) : (
                <TabLoading />
              )}
            </TabsContent>
            {isAdmin && (
              <TabsContent value="costing" className="m-0 h-full">
                {equipmentOptions ? (
                  <JobProfitability
                    timeEntries={timeEntries}
                    staffCostProfiles={staffCostProfiles}
                    expenses={expenses}
                    equipmentUsage={equipmentUsage}
                    equipmentOptions={equipmentOptions}
                    invoices={jobInvoices}
                    jobItems={lineItems}
                    variations={variations}
                    minMarginPct={minMarginPct}
                  />
                ) : (
                  <TabLoading />
                )}
              </TabsContent>
            )}
            <TabsContent value="documents" className="m-0 h-full">
              <JobDocuments jobId={job.id} documents={documents} onUpdate={setDocuments} currentUserId={currentUserId} isOffice={isOffice} />
            </TabsContent>
            <TabsContent value="photos" className="m-0 h-full">
              <JobPhotos jobId={job.id} photos={photos} onUpdate={setPhotos} currentUserId={currentUserId} />
            </TabsContent>
            <TabsContent value="items" className="m-0 h-full">
              <JobLineItems jobId={job.id} lineItems={lineItems} pricingItems={pricingItems} onUpdate={setLineItems} />
            </TabsContent>
            <TabsContent value="notes" className="m-0 h-full">
              <JobNotes
                jobId={job.id}
                notes={notes}
                onUpdate={setNotes}
                currentUserId={currentUserId}
                stageNotes={stageNotes}
                onUpdateStageNotes={setStageNotes}
              />
            </TabsContent>
            <TabsContent value="signature" className="m-0 h-full">
              <JobSignature jobId={job.id} currentUserId={currentUserId} existingSignature={job.completion_notes} voiceReportTranscript={job.voice_report_transcript} />
            </TabsContent>
          </div>
        </Tabs>
      </div>

      <DeleteJobDialog
        jobId={job.id}
        jobNumber={job.job_number}
        jobTitle={job.title}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />

      {scheduleMounted && (
        <ScheduleJobDialog
          open={scheduleOpen}
          onOpenChange={setScheduleOpen}
          jobId={job.id}
          jobNumber={job.job_number}
          jobStatus={job.status}
          staff={staff}
          currentAssignedIds={currentAssignedIds}
          currentUserId={currentUserId}
          currentScheduledStart={job.scheduled_start}
          currentScheduledEnd={job.scheduled_end}
          costCenters={costCenters}
          currentScheduledCostCenterId={job.scheduled_cost_center_id}
        />
      )}
    </div>
  );
}
