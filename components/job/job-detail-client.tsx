"use client";

import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Briefcase, FileText, Image, List, MessageSquare, PenLine, ClipboardList, Clock, Receipt } from "lucide-react";
import Link from "next/link";
import { JobOverview } from "./job-overview";
import { JobDocuments } from "./job-documents";
import { JobPhotos } from "./job-photos";
import { JobLineItems } from "./job-line-items";
import { JobNotes } from "./job-notes";
import { JobSignature } from "./job-signature";
import { JobPO } from "./job-po";
import { JobTime } from "./job-time";

const statusColors: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  scheduled: "bg-blue-100 text-blue-800",
  in_progress: "bg-purple-100 text-purple-800",
  completed: "bg-green-100 text-green-800",
  cancelled: "bg-red-100 text-red-800",
  on_hold: "bg-gray-100 text-gray-700",
};

const priorityColors: Record<string, string> = {
  low: "bg-gray-100 text-gray-600",
  normal: "bg-blue-100 text-blue-700",
  high: "bg-orange-100 text-orange-700",
  urgent: "bg-red-100 text-red-700",
};

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
}

export function JobDetailClient({ job, currentUserId, photos: initialPhotos, documents: initialDocuments, notes: initialNotes, lineItems: initialLineItems, pricingItems, staff, purchaseOrders: initialPOs, timeEntries: initialTimeEntries }: Props) {
  const [photos, setPhotos] = useState(initialPhotos);
  const [documents, setDocuments] = useState(initialDocuments);
  const [notes, setNotes] = useState(initialNotes);
  const [lineItems, setLineItems] = useState(initialLineItems);
  const [purchaseOrders, setPurchaseOrders] = useState(initialPOs);
  const totalHoursLogged = initialTimeEntries.reduce((sum: number, e: any) => sum + (e.hours ? Number(e.hours) : 0), 0);

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
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${statusColors[job.status]}`}>
                  {job.status.replace("_", " ")}
                </span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium capitalize ${priorityColors[job.priority]}`}>
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
          {job.ready_to_invoice && (
            <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-amber-100 text-amber-700 shrink-0">
              Awaiting Invoice
            </span>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex-1 overflow-hidden">
        <Tabs defaultValue="overview" className="h-full flex flex-col">
          <div className="bg-white border-b px-6 overflow-x-auto">
            <TabsList className="h-auto bg-transparent p-0 gap-0 flex w-max min-w-full">
              {[
                { value: "overview", label: "Overview", icon: Briefcase },
                { value: "po", label: "Purchase Orders", icon: ClipboardList },
                { value: "time", label: "Time", icon: Clock },
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
              <JobPO jobId={job.id} pos={purchaseOrders} totalHoursLogged={totalHoursLogged} onUpdate={setPurchaseOrders} />
            </TabsContent>
            <TabsContent value="time" className="m-0 h-full">
              <JobTime jobId={job.id} currentUserId={currentUserId} timeEntries={initialTimeEntries} pos={purchaseOrders} />
            </TabsContent>
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
              <JobSignature jobId={job.id} currentUserId={currentUserId} existingSignature={job.completion_notes} />
            </TabsContent>
          </div>
        </Tabs>
      </div>
    </div>
  );
}
