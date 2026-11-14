"use client";

import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ArrowLeft, Truck, FileText, DollarSign, Gauge, Settings, Wrench } from "lucide-react";
import Link from "next/link";
import { EquipmentDocuments } from "./equipment-documents";
import { EquipmentExpenses } from "./equipment-expenses";
import { EquipmentCostDialog } from "./equipment-cost-dialog";
import { computeEquipmentCost, EQUIPMENT_CATEGORY_LABELS } from "@/lib/equipment-cost";
import { equipmentCategoryColors } from "@/lib/badge-colors";
import { formatDate } from "@/lib/date";
import { EquipmentYearCost } from "./equipment-year-cost";
import { EquipmentServiceRecords } from "./equipment-service-records";
import { dueLabel, serviceDue, type ServiceRecord } from "@/lib/service-due";
import type { EffectiveRate } from "@/lib/fleet-costs";

interface Props {
  equipment: any;
  today: string;
  /** null = service records not in this database yet (0099). */
  services: ServiceRecord[] | null;
  canEditServices: boolean;
  currentUserId: string;
  isAdmin: boolean;
  documents: any[];
  expenses: any[];
  usage: any[];
  staff: any[];
}

export function EquipmentDetailClient({ equipment, today, services: initialServices, canEditServices, currentUserId, isAdmin, documents: initialDocuments, expenses: initialExpenses, usage, staff }: Props) {
  const [documents, setDocuments] = useState(initialDocuments);
  const [expenses, setExpenses] = useState(initialExpenses);
  const [services, setServices] = useState(initialServices);
  const due = services ? serviceDue(services, today) : null;
  const [costDialogOpen, setCostDialogOpen] = useState(false);

  const { costPerHour: estimatePerHour, annualTotalCost } = computeEquipmentCost(equipment);
  // The rate job costing uses (lib/fleet-costs.ts): actual once there is
  // enough logged, else the estimate. Computed on the server at page load.
  const rate: EffectiveRate | undefined = equipment.effective_rate;
  const costPerHour = rate?.costPerHour ?? estimatePerHour;
  const assignedStaff = staff.find((s) => s.id === equipment.assigned_to);
  const totalUsageHours = usage.reduce((sum: number, u: any) => sum + Number(u.hours || 0), 0);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="bg-white border-b px-6 py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            <Link href="/dashboard/fleet">
              <Button variant="ghost" size="sm" className="gap-1.5 text-slate-500 mt-0.5">
                <ArrowLeft className="w-4 h-4" /> Back
              </Button>
            </Link>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl font-bold text-slate-900">{equipment.name}</h1>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${equipmentCategoryColors[equipment.category] ?? ""}`}>
                  {EQUIPMENT_CATEGORY_LABELS[equipment.category] ?? equipment.category}
                </span>
                {!equipment.is_active && <span className="text-xs text-slate-400">(inactive)</span>}
              </div>
              <p className="text-sm text-slate-500 mt-0.5">
                {equipment.registration && <span>{equipment.registration} · </span>}
                {assignedStaff ? `Assigned to ${assignedStaff.full_name}` : "Unassigned"}
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" className="gap-2 shrink-0" onClick={() => setCostDialogOpen(true)}>
            <Settings className="w-3.5 h-3.5" />Cost Profile &amp; Usage
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex-1 overflow-hidden">
        <Tabs defaultValue="overview" className="h-full flex flex-col">
          <div className="bg-white border-b px-6 overflow-x-auto">
            <TabsList className="h-auto bg-transparent p-0 gap-0 flex w-max min-w-full">
              {[
                { value: "overview", label: "Overview", icon: Truck },
                { value: "documents", label: "Documents", icon: FileText },
                { value: "service", label: "Service history", icon: Wrench },
                { value: "expenses", label: "Expenses & Service", icon: DollarSign },
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
            <TabsContent value="overview" className="m-0 h-full p-6 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <Card>
                  <CardContent className="pt-4 pb-4">
                    <p className="text-xs text-slate-500">Cost per hour (used for job costing)</p>
                    <p className="text-lg font-bold text-slate-900">${costPerHour.toFixed(2)}/hr</p>
                    {rate && (
                      <p className={`text-[11px] mt-0.5 ${rate.source === "actual" ? "text-green-700" : "text-amber-700"}`}>
                        {rate.source === "actual"
                          ? `Actual, last 12 months · estimate was $${rate.estimateCostPerHour.toFixed(2)}`
                          : `Estimate — ${rate.reason}`}
                      </p>
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-4 pb-4">
                    <p className="text-xs text-slate-500">Estimated Annual Cost</p>
                    <p className="text-lg font-bold text-slate-900">${annualTotalCost.toLocaleString("en-AU", { maximumFractionDigits: 0 })}</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-4 pb-4 flex items-center gap-3">
                    <Gauge className="w-5 h-5 text-slate-400" />
                    <div>
                      <p className="text-xs text-slate-500">Hours Logged (all time)</p>
                      <p className="text-lg font-bold text-slate-900">{totalUsageHours.toFixed(1)}h</p>
                    </div>
                  </CardContent>
                </Card>
              </div>

              {due && (
                <p className={`text-sm font-medium ${due.state === "overdue" ? "text-red-700" : due.state === "due_soon" ? "text-amber-700" : "text-slate-600"}`}>
                  <Wrench className="w-3.5 h-3.5 inline mr-1.5 -mt-0.5" />
                  {dueLabel(due)}{due.dueDate ? ` (${formatDate(due.dueDate)})` : ""}
                  {due.dueKm != null ? ` · or at ${due.dueKm.toLocaleString("en-AU")} km` : ""}
                </p>
              )}

              <EquipmentYearCost expenses={expenses} usage={usage} today={today} estimatedAnnualCost={annualTotalCost} />

              {rate?.source === "actual" && (
                <Card>
                  <CardContent className="pt-4 pb-4 text-sm space-y-1">
                    <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide">How the actual rate is worked out (last 12 months)</p>
                    <div className="flex justify-between"><span className="text-slate-500">Depreciation for {rate.window.days} days</span><span>${rate.actual.depreciation.toFixed(2)}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">Logged expenses (ex GST)</span><span>${rate.actual.expenses.toFixed(2)}</span></div>
                    {rate.actual.fuelEstimate > 0 && (
                      <div className="flex justify-between"><span className="text-slate-500">Fuel (estimated — none logged)</span><span>${rate.actual.fuelEstimate.toFixed(2)}</span></div>
                    )}
                    <div className="flex justify-between border-t pt-1 font-medium"><span>Total ÷ {rate.actual.hours.toFixed(1)}h worked</span><span>${rate.costPerHour.toFixed(2)}/hr</span></div>
                    <p className="text-xs text-slate-400 pt-1">
                      {equipment.assigned_to ? "Hours worked = the assigned driver's clocked work hours." : "Hours worked = usage logged against jobs."}
                    </p>
                  </CardContent>
                </Card>
              )}

              <Card>
                <CardContent className="pt-4 pb-4 space-y-2 text-sm">
                  {equipment.purchase_date && (
                    <div className="flex justify-between"><span className="text-slate-500">Purchase Date</span><span className="font-medium text-slate-800">{formatDate(equipment.purchase_date)}</span></div>
                  )}
                  <div className="flex justify-between"><span className="text-slate-500">Documents on file</span><span className="font-medium text-slate-800">{documents.length}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">Expenses logged</span><span className="font-medium text-slate-800">{expenses.length}</span></div>
                  {equipment.notes && (
                    <div className="pt-2 border-t">
                      <p className="text-slate-500 mb-1">Notes</p>
                      <p className="text-slate-700 whitespace-pre-wrap">{equipment.notes}</p>
                    </div>
                  )}
                </CardContent>
              </Card>

              <p className="text-xs text-slate-400">
                The cost profile (depreciation, insurance, maintenance, fuel) that drives the $/hour figure above, plus the general usage-hours log, are edited via &ldquo;Cost Profile &amp; Usage&rdquo; above. Actual receipts and paperwork live in the Documents and Expenses &amp; Service tabs.
              </p>
            </TabsContent>

            <TabsContent value="documents" className="m-0 h-full">
              <EquipmentDocuments equipmentId={equipment.id} documents={documents} onUpdate={setDocuments} currentUserId={currentUserId} />
            </TabsContent>

            <TabsContent value="service" className="m-0 h-full">
              <EquipmentServiceRecords
                equipmentId={equipment.id}
                records={services}
                onRecordsChange={setServices}
                expenses={expenses}
                onExpenseCreated={(e) => setExpenses((list: any[]) => [e, ...list].sort((a, b) => (a.expense_date < b.expense_date ? 1 : -1)))}
                canEdit={canEditServices}
                currentUserId={currentUserId}
                today={today}
              />
            </TabsContent>

            <TabsContent value="expenses" className="m-0 h-full">
              <EquipmentExpenses equipmentId={equipment.id} expenses={expenses} onUpdate={setExpenses} currentUserId={currentUserId} />
            </TabsContent>
          </div>
        </Tabs>
      </div>

      <EquipmentCostDialog
        equipmentId={equipment.id}
        equipmentName={equipment.name}
        open={costDialogOpen}
        onOpenChange={setCostDialogOpen}
      />
    </div>
  );
}
