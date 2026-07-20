"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Briefcase, FileText, Image, List, MessageSquare, PenLine, ClipboardList, Clock, Receipt, GitPullRequestArrow, DollarSign, Truck, TrendingUp, Trash2 } from "lucide-react";
import Link from "next/link";
import { JobOverview } from "./job-overview";
import { DeleteJobDialog } from "./delete-job-dialog";
import { JobDocuments } from "./job-documents";
import { JobPhotos } from "./job-photos";
import { JobLineItems } from "./job-line-items";
import { JobNotes } from "./job-notes";
import { JobSignature } from "./job-signature";
import { JobPO } from "./job-po";
import { JobTime } from "./job-time";
import { JobVariations } from "./job-variations";
import { JobExpenses } from "./job-expenses";
import { JobEquipment } from "./job-equipment";
import { JobProfitability } from "./job-profitability";
import { jobStatusColors, jobPriorityColors } from "@/lib/badge-colors";

// Kept in sync with the `value`s in the TabsTrigger list below — used to
// validate a `?tab=` query param (e.g. from the Approvals page's "Price &
// review" link) before trusting it as the initial active tab.
const TAB_VALUES = ["overview", "po", "time", "variations", "expenses", "equipment", "costing", "documents", "photos", "items", "notes", "signature"];

interface Props {
  job: any;
  currentUserId: string;
  photos: any[];
  documents: any[];
  notes: any[];
  lineItems: any[];
  pricingItems: any[];
  staff: any[];
  purchaseOrders: any[];
  timeEntries: any[];
  variations: any[];
  variationTypes: any[];
  expenses: any[];
  equipmentOptions: any[];
  equipmentUsage: any[];
  isAdmin: boolean;
  staffCostProfiles: any[];
  jobInvoices: any[];
}

export function JobDetailClient({ job, currentUserId, photos: initialPhotos, documents: initialDocuments, notes: initialNotes, lineItems: initialLineItems, pricingItems, staff, purchaseOrders: initialPOs, timeEntries: initialTimeEntries, variations: initialVariations, variationTypes, expenses: initialExpenses, equipmentOptions, equipmentUsage: initialEquipmentUsage, isAdmin, staffCostProfiles, jobInvoices }: Props) {
  // Deep-links like /dashboard/jobs/[id]?tab=variations&variation=[id]
  // (used by the Approvals page's "Price & review" link) land here — read
  // them once on mount so the right tab opens and the right variation is
  // highlighted, instead of always defaulting to Overview.
  const searchParams = useSearchParams();
  const requestedTab = searchParams.get("tab");
  const [activeTab, setActiveTab] = useState(
    requestedTab && TAB_VALUES.includes(requestedTab) ? requestedTab : "overview"
  );
  const highlightVariationId = searchParams.get("variation");
  const [deleteOpen, setDeleteOpen] = useState(false);

  const [photos, setPhotos] = useState(initialPhotos);
  const [documents, setDocuments] = useState(initialDocuments);
  const [notes, setNotes] = useState(initialNotes);
  const [lineItems, setLineItems] = useState(initialLineItems);
  const [purchaseOrders, setPurchaseOrders] = useState(initialPOs);
  const [timeEntries, setTimeEntries] = useState(initialTimeEntries);
  const [variations, setVariations] = useState(initialVariations);
  const [expenses, setExpenses] = useState(initialExpenses);
  const [equipmentUsage, setEquipmentUsage] = useState(initialEquipmentUsage);
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
              </div>
              <p className="text-sm text-slate-500 mt-0.5">
                {job.customers?.name}
                {job.sites ? ` · ${job.sites.name}, ${job.sites.suburb}` : ""}
                {""}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
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
                { value: "po", label: "Purchase Orders", icon: ClipboardList },
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
              <JobOverview job={job} staff={staff} />
            </TabsContent>
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
              />
            </TabsContent>
            <TabsContent value="time" className="m-0 h-full">
              <JobTime jobId={job.id} currentUserId={currentUserId} timeEntries={timeEntries} pos={purchaseOrders} costCenters={costCenters} isAdmin={isAdmin} staff={staff} onUpdate={setTimeEntries} />
            </TabsContent>
            <TabsContent value="variations" className="m-0 h-full">
              <JobVariations jobId={job.id} variations={variations} variationTypes={variationTypes} currentUserId={currentUserId} onUpdate={setVariations} highlightVariationId={highlightVariationId} />
            </TabsContent>
            <TabsContent value="expenses" className="m-0 h-full">
              <JobExpenses jobId={job.id} jobNumber={job.job_number} expenses={expenses} onUpdate={setExpenses} currentUserId={currentUserId} costCenters={costCenters} />
            </TabsContent>
            <TabsContent value="equipment" className="m-0 h-full">
              <JobEquipment jobId={job.id} usage={equipmentUsage} equipmentOptions={equipmentOptions} onUpdate={setEquipmentUsage} />
            </TabsContent>
            {isAdmin && (
              <TabsContent value="costing" className="m-0 h-full">
                <JobProfitability
                  timeEntries={timeEntries}
                  staffCostProfiles={staffCostProfiles}
                  expenses={expenses}
                  equipmentUsage={equipmentUsage}
                  equipmentOptions={equipmentOptions}
                  invoices={jobInvoices}
                />
              </TabsContent>
            )}
            <TabsContent value="documents" className="m-0 h-full">
              <JobDocuments jobId={job.id} documents={documents} onUpdate={setDocuments} currentUserId={currentUserId} />
            </TabsContent>
            <TabsContent value="photos" className="m-0 h-full">
              <JobPhotos jobId={job.id} photos={photos} onUpdate={setPhotos} currentUserId={currentUserId} />
            </TabsContent>
            <TabsContent value="items" className="m-0 h-full">
              <JobLineItems jobId={job.id} lineItems={lineItems} pricingItems={pricingItems} onUpdate={setLineItems} />
            </TabsContent>
            <TabsContent value="notes" className="m-0 h-full">
              <JobNotes jobId={job.id} notes={notes} onUpdate={setNotes} currentUserId={currentUserId} />
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
    </div>
  );
}
