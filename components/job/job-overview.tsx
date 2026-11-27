"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { applyScheduleChange, type ScheduleWriteClient } from "@/lib/schedule-dispatch";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { CUSTOMER_PO_MAX, normalizeCustomerPo } from "@/lib/customer-po";
import { SiteLocationDialog } from "@/components/site-location-dialog";
import { SITE_FENCE_CHOICES, fenceLabel } from "@/lib/clock-location";
import { Phone, Mail, MapPin, User, Save, Navigation, CalendarClock } from "lucide-react";
import { formatDate } from "@/lib/date";
import { formatDateKeyRange } from "@/lib/schedule-form";
import { scheduleDays } from "@/lib/scheduling";
import { bookingWindow, describeBooking, type JobBookingWithNames } from "@/lib/bookings";
import { BookingAttendanceTag } from "@/components/schedule/booking-attendance-tag";
import { BookingMissedDialog, type MissedTarget } from "@/components/schedule/booking-missed-dialog";
import { missedAction } from "@/components/schedule/board-actions";
import { dateKeyInBusinessTZ } from "@/lib/date";
import { leaveDateLabel, leaveDayLabel, NEEDS_REASSIGNING, type LeaveConflict } from "@/lib/staff-leave";
import { CustomerPicker } from "@/components/customer-picker";
import { AddSiteDialog } from "@/components/site-add-dialog";
import { SitePicker } from "@/components/job/site-picker";
import { openStagesWarning, type CompletionStage } from "@/lib/stage-completion";

interface Props {
  job: any;
  /** A technician viewing a job they are not assigned to: every field read-only. */
  readOnly?: boolean;
  /** The job's bookings — who, which cost centre, when. Shown to everyone. */
  bookings: JobBookingWithNames[];
  bookingsError?: string | null;
  /** Booking id → the days its technician is on leave (0112 — a draft, not applied yet). */
  leaveClashes?: ReadonlyMap<string, LeaveConflict[]>;
  /** Bookings nobody clocked on to (office/admin only — "Not attended", lib/booking-attendance.ts). */
  notAttendedIds?: ReadonlySet<string>;
  /** A technician on a job they are not on: the Schedule card is left out. */
  hideSchedule?: boolean;
  /** Opens the Schedule dialog; absent for anyone who cannot change bookings (not office/admin). */
  onEditSchedule?: () => void;
  /** Office/admin: may set the site's map pin (sites are office-writable, 0064). */
  canEditSite?: boolean;
  /** Office/admin: "Didn't make it…" on each booking (0121; 27 Nov 2026). */
  canFlagMissed?: boolean;
}

// The Site picker (components/job/site-picker.tsx) offers "No site" — a job
// can exist without a site — and, first, "+ Add new site", which opens the
// "Add New Site" dialog inline, so a wrong/missing site can be fixed here
// without a trip to the Customer page — same picker as the New Job form.

export function JobOverview({ job, readOnly = false, bookings, bookingsError, leaveClashes, notAttendedIds, hideSchedule = false, onEditSchedule, canEditSite = false, canFlagMissed = false }: Props) {
  const [pinOpen, setPinOpen] = useState(false);
  const [missedTarget, setMissedTarget] = useState<MissedTarget | null>(null);
  const todayKey = dateKeyInBusinessTZ(new Date());
  const router = useRouter();
  const supabase = createClient();
  const [savingFence, setSavingFence] = useState(false);

  async function setFence(metres: number | null) {
    setSavingFence(true);
    const { error, count } = await supabase
      .from("sites")
      .update({ geofence_radius_m: metres }, { count: "exact" })
      .eq("id", job.site_id);
    setSavingFence(false);
    if (error || count === 0) {
      toast.error("Couldn't change the clock-on area.");
      return;
    }
    toast.success(`Auto clock-on area is now ${fenceLabel(metres)}. Phones pick it up on their next sync.`);
    router.refresh();
  }
  const [saving, setSaving] = useState(false);
  const [sites, setSites] = useState<any[]>([]);
  const [addSiteOpen, setAddSiteOpen] = useState(false);
  const [form, setForm] = useState({
    title: job.title ?? "",
    job_type: job.job_type ?? "service",
    customer_id: job.customer_id ?? "",
    site_id: job.site_id ?? "",
    status: job.status,
    priority: job.priority,
    description: job.description ?? "",
    notes: job.notes ?? "",
    customer_po: job.customer_po ?? "",
  });
  // The schedule is NOT edited here any more. It is the job's bookings — each
  // technician's own time and cost centre (job_bookings, 0079) — shown read-only below and changed in the Schedule dialog.
  // This form used to write the job's one window and its assigned_to: with
  // bookings, the window write is translated into "everyone on this window"
  // and the assigned_to write collapses the crew (0059), so either one,
  // made by an unrelated save of the title, would flatten the bookings.

  // Sites belong to a customer, so the site list has to be reloaded whenever
  // the customer changes — same pattern as the "New Job" form. Also runs
  // once on mount so the current site shows up in the dropdown immediately.
  useEffect(() => {
    async function loadSites() {
      if (!form.customer_id) { setSites([]); return; }
      // Active sites only — plus the job's saved site even if it has since
      // been archived, so the dropdown never blanks out an existing value.
      let query = supabase.from("sites").select("id, name, suburb, address_line1").eq("customer_id", form.customer_id);
      query = job.site_id ? query.or(`is_active.eq.true,id.eq.${job.site_id}`) : query.eq("is_active", true);
      const { data } = await query;
      setSites(data ?? []);
    }
    loadSites();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.customer_id]);

  // First to last booked day across every booking.
  const bookedDays = bookings.flatMap((b) => scheduleDays(bookingWindow(b))).map((d) => d.dateKey).sort();
  const scheduledRange = bookedDays.length > 0 ? formatDateKeyRange(bookedDays[0], bookedDays[bookedDays.length - 1]) : null;

  function set(field: string, value: string | null) {
    setForm((prev) => ({ ...prev, [field]: value ?? "" }));
  }

  // Changing the customer invalidates whatever site was previously selected
  // (it belongs to the old customer), so clear it rather than silently
  // keeping a site_id that no longer matches the chosen customer.
  function setCustomer(customerId: string) {
    setForm((prev) => ({ ...prev, customer_id: customerId, site_id: "" }));
  }

  async function save() {
    if (!form.title.trim()) {
      toast.error("Job title is required");
      return;
    }
    if (!form.customer_id) {
      toast.error("Customer is required");
      return;
    }
    // Completing the whole job by hand while some stages (builder PO lines)
    // are still open: say which, and ask (22 Nov 2026). A failed read never
    // blocks the save.
    if (form.status === "completed" && job.status !== "completed") {
      const res = await fetch(`/api/jobs/${job.id}/stages`).catch(() => null);
      const body = res?.ok ? ((await res.json().catch(() => null)) as { stages?: CompletionStage[] } | null) : null;
      const warning = openStagesWarning(body?.stages ?? null);
      if (warning && !window.confirm(warning)) return;
    }
    setSaving(true);
    // Through the same seam the board used: the write and the Google push are
    // one act with two outcomes. The schedule is no longer edited here, but
    // the status is — completing or cancelling a job removes its calendar
    // events — and the title, customer and site are in every event's text.
    const result = await applyScheduleChange(supabase as unknown as ScheduleWriteClient, job.id, {
      ...form,
      title: form.title.trim(),
      site_id: form.site_id || null,
      customer_po: normalizeCustomerPo(form.customer_po),
    });
    if (!result.ok) {
      toast.error(result.error);
    } else {
      // Saved is saved — but "Job updated" alone would let someone leave
      // believing the technician's calendar shows the new time.
      if (result.calendarSynced) toast.success("Job updated");
      else toast.warning("Job updated — Google Calendar not updated");
      // customer/site changed => the header and the read-only customer/site
      // cards below (which come from the server-fetched `job` prop, not this
      // form's local state) need a re-fetch to reflect the change.
      router.refresh();
    }
    setSaving(false);
  }

  return (
    <div className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Left — editable fields */}
      <div className="lg:col-span-2 space-y-4">
        {/* A disabled fieldset disables every input, select and button in both
            cards in one place; links (call, email, maps) stay usable. */}
        <fieldset disabled={readOnly} className="space-y-4 min-w-0">
        <Card>
          <CardHeader><CardTitle className="text-base">Job Details</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Job Title *</Label>
              <Input value={form.title} onChange={(e) => set("title", e.target.value)} placeholder="e.g. Fix burst pipe in bathroom" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Customer *</Label>
                <CustomerPicker value={form.customer_id} onChange={setCustomer} placeholder="Search customers..." />
              </div>
              <div className="space-y-2">
                <Label>Site</Label>
                <SitePicker
                  sites={sites}
                  value={form.site_id}
                  onChange={(id) => set("site_id", id)}
                  onAddNew={() => setAddSiteOpen(true)}
                  allowNone
                  disabled={!form.customer_id}
                  placeholder={form.customer_id ? "Select site" : "Select customer first"}
                />
              </div>
              <div className="space-y-2">
                <Label>Job Type</Label>
                <Select value={form.job_type} onValueChange={(v) => set("job_type", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="service">Service</SelectItem>
                    <SelectItem value="installation">Installation</SelectItem>
                    <SelectItem value="maintenance">Maintenance</SelectItem>
                    <SelectItem value="emergency">Emergency</SelectItem>
                    <SelectItem value="quote">Quote</SelectItem>
                    <SelectItem value="project">Project</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="customer_po">Customer PO number</Label>
                <Input
                  id="customer_po"
                  value={form.customer_po}
                  onChange={(e) => set("customer_po", e.target.value)}
                  maxLength={CUSTOMER_PO_MAX}
                  placeholder="e.g. 4500123"
                />
                <p className="text-xs text-slate-400">Goes on every invoice for this job.</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-base">Job Status</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Status</Label>
                <Select value={form.status} onValueChange={(v) => set("status", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="scheduled">Scheduled</SelectItem>
                    <SelectItem value="in_progress">In Progress</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                    <SelectItem value="on_hold">On Hold</SelectItem>
                    <SelectItem value="cancelled">Cancelled</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Priority</Label>
                <Select value={form.priority} onValueChange={(v) => set("priority", v)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                    <SelectItem value="urgent">Urgent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea value={form.description} onChange={(e) => set("description", e.target.value)} rows={3} placeholder="Job description..." />
            </div>
            <div className="space-y-2">
              <Label>Internal Notes</Label>
              <Textarea value={form.notes} onChange={(e) => set("notes", e.target.value)} rows={2} placeholder="Notes for the technician..." />
            </div>
            {!readOnly && (
              <div className="flex justify-end">
                <Button onClick={save} disabled={saving} className="gap-2">
                  <Save className="w-4 h-4" />{saving ? "Saving..." : "Save Changes"}
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
        </fieldset>

        {/* Outside the fieldset: read-only for everyone, and the Edit button
            must stay usable for office on a view-only page too. */}
        {!hideSchedule && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-base">Schedule</CardTitle>
              {onEditSchedule && (
                <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={onEditSchedule}>
                  <CalendarClock className="w-4 h-4" />
                  Edit schedule
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {bookingsError && <p className="text-xs text-red-600 mb-2">Bookings could not be loaded.</p>}
            {bookings.length === 0 ? (
              <p className="text-sm text-slate-400">Not scheduled.</p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {bookings.map((b) => (
                  <li key={b.id} className="py-2 flex items-start gap-3">
                    <User className="w-4 h-4 text-slate-400 mt-0.5 flex-shrink-0" />
                    <div className="min-w-0">
                      <p className={b.staff_id ? "text-sm font-medium text-slate-900" : "text-sm font-medium text-amber-700"}>
                        {b.staff_id ? b.staff_name ?? "Technician" : "Unassigned"}
                        {b.cost_center_name && <span className="font-normal text-cyan-700"> · {b.cost_center_name}</span>}
                      </p>
                      <p className="text-xs text-slate-500">
                        {describeBooking(b)}
                        {b.all_day ? " · All day" : ""}
                      </p>
                      {b.note && <p className="text-xs text-amber-800 whitespace-pre-wrap mt-0.5">Note: {b.note}</p>}
                      <BookingAttendanceTag booking={{ ...b, not_attended: notAttendedIds?.has(b.id) }} className="text-xs mt-0.5 whitespace-normal" />
                      {b.missed_note && <p className="text-xs text-red-700 whitespace-pre-wrap">{b.missed_note}</p>}
                      {!readOnly && (() => {
                        const action = missedAction(b, job.status, todayKey, canFlagMissed);
                        if (!action) return null;
                        return (
                          <button
                            type="button"
                            className="mt-0.5 text-xs font-medium text-slate-500 underline-offset-2 hover:text-red-700 hover:underline"
                            onClick={() =>
                              setMissedTarget({
                                jobId: job.id,
                                bookingId: b.id,
                                title: `#${job.job_number} — ${b.staff_name ?? "Technician"}, ${describeBooking(b)}`,
                                missed: b,
                              })
                            }
                          >
                            {action === "change" ? "Didn't make it — change or clear…" : "Didn't make it…"}
                          </button>
                        );
                      })()}
                      {(leaveClashes?.get(b.id)?.length ?? 0) > 0 && (
                        <p className="text-xs text-rose-700 mt-0.5">
                          <span className="inline-block rounded bg-rose-600 px-1 font-bold text-white mr-1">{NEEDS_REASSIGNING}</span>
                          {leaveClashes!
                            .get(b.id)!
                            .map((c) => `${leaveDayLabel(c.leaveDay)} ${leaveDateLabel(c.dateKey)}`)
                            .join(", ")}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        )}
      </div>

      {/* Right — customer & site info */}
      <div className="space-y-4">
        <Card>
          <CardHeader><CardTitle className="text-base">Customer</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center gap-2">
              <User className="w-4 h-4 text-slate-400 flex-shrink-0" />
              <span className="text-sm font-medium">{job.customers?.name}</span>
            </div>
            {job.customers?.phone && (
              <div className="flex items-center gap-2">
                <Phone className="w-4 h-4 text-slate-400 flex-shrink-0" />
                <a href={`tel:${job.customers.phone}`} className="text-sm text-blue-600 hover:underline">{job.customers.phone}</a>
              </div>
            )}
            {job.customers?.mobile && (
              <div className="flex items-center gap-2">
                <Phone className="w-4 h-4 text-slate-400 flex-shrink-0" />
                <a href={`tel:${job.customers.mobile}`} className="text-sm text-blue-600 hover:underline">{job.customers.mobile} (mobile)</a>
              </div>
            )}
            {job.customers?.email && (
              <div className="flex items-center gap-2">
                <Mail className="w-4 h-4 text-slate-400 flex-shrink-0" />
                <a href={`mailto:${job.customers.email}`} className="text-sm text-blue-600 hover:underline truncate">{job.customers.email}</a>
              </div>
            )}
          </CardContent>
        </Card>

        {job.sites && (
          <Card>
            <CardHeader><CardTitle className="text-base">Site</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              <div className="flex items-start gap-2">
                <MapPin className="w-4 h-4 text-slate-400 flex-shrink-0 mt-0.5" />
                <div className="text-sm">
                  <p className="font-medium">{job.sites.name}</p>
                  <p className="text-slate-500">{job.sites.address_line1}</p>
                  <p className="text-slate-500">{job.sites.suburb} {job.sites.state} {job.sites.postcode}</p>
                  <a
                    href={
                      job.sites.site_lat && job.sites.site_lng
                        ? `https://waze.com/ul?ll=${job.sites.site_lat},${job.sites.site_lng}&navigate=yes`
                        : `https://waze.com/ul?q=${encodeURIComponent(`${job.sites.address_line1} ${job.sites.suburb} ${job.sites.state}`)}&navigate=yes`
                    }
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-blue-600 hover:underline text-xs mt-1"
                  >
                    <Navigation className="w-3 h-3" />
                    Navigate with Waze
                  </a>
                </div>
              </div>
              {/* The auto clock-in geofence needs the site's coordinates. The
                  hourly geocoder (/api/sites/geocode-missing) fills them from
                  the address when it can place it precisely; when it can't
                  (a brand-new estate street, a typo), say so here. */}
              {(job.sites.site_lat == null || job.sites.site_lng == null) && (
                <p className="rounded-md bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800">
                  No map location for this address, so auto clock-in won&apos;t work here.
                  {canEditSite ? " Set it on the map, or check the address is correct." : " Ask the office to set it on the map."}
                  <span className="mt-1 block">
                    Set it on site: open the job on the phone and tap &ldquo;Set site location here&rdquo; (the phone also offers it at a manual clock-on){canEditSite ? ", or drop a pin here." : "."}
                  </span>
                </p>
              )}
              {canEditSite && job.site_id && (
                <Button variant="outline" size="sm" className="gap-1.5 h-8" onClick={() => setPinOpen(true)}>
                  <MapPin className="w-3.5 h-3.5" />
                  {job.sites.site_lat == null ? "Set location on map" : "Adjust map pin"}
                </Button>
              )}
              {/* A big site (subdivision, long civil job) needs a bigger
                  auto clock-on fence than the standard 150 m (Justin, 2 Nov
                  2026). */}
              {job.site_id && job.sites.site_lat != null && (
                <div className="flex items-center gap-2 text-xs text-slate-600">
                  <span>Auto clock-on area</span>
                  {canEditSite ? (
                    <Select
                      value={String(job.sites.geofence_radius_m ?? "standard")}
                      onValueChange={(v) => setFence(v === "standard" ? null : Number(v))}
                      disabled={savingFence}
                    >
                      <SelectTrigger className="h-7 w-[170px] text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="standard">{fenceLabel(null)} (standard)</SelectItem>
                        {SITE_FENCE_CHOICES.map((m) => (
                          <SelectItem key={m} value={String(m)}>{fenceLabel(m)} — big site</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="font-medium">{fenceLabel(job.sites.geofence_radius_m)}</span>
                  )}
                </div>
              )}
              {canEditSite && job.site_id && pinOpen && (
                <SiteLocationDialog
                  site={{ id: job.site_id, ...job.sites }}
                  open={pinOpen}
                  onOpenChange={setPinOpen}
                />
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader><CardTitle className="text-base">Timeline</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-slate-500">Created</span>
              <span>{formatDate(job.created_at)}</span>
            </div>
            {scheduledRange && (
              <div className="flex justify-between">
                <span className="text-slate-500">Scheduled</span>
                <span>{scheduledRange}</span>
              </div>
            )}
            {job.actual_start && (
              <div className="flex justify-between">
                <span className="text-slate-500">Started</span>
                <span>{formatDate(job.actual_start)}</span>
              </div>
            )}
            {job.actual_end && (
              <div className="flex justify-between">
                <span className="text-slate-500">Completed</span>
                <span>{formatDate(job.actual_end)}</span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <AddSiteDialog
        customerId={form.customer_id}
        open={addSiteOpen}
        onOpenChange={setAddSiteOpen}
        onCreated={(site) => {
          setSites((prev) => (prev.some((s) => s.id === site.id) ? prev : [...prev, site]));
          set("site_id", site.id);
        }}
      />
      <BookingMissedDialog target={missedTarget} onClose={() => setMissedTarget(null)} onSaved={() => router.refresh()} />
    </div>
  );
}
