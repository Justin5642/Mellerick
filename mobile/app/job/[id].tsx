import { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Modal, Alert, TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../lib/supabase";
import { getJob } from "../../lib/data/reads/jobs";
import { colors, statusColors } from "../../lib/theme";
import { ScreenError } from "../../design/components/ScreenError";
import { useIsOfficeOrAdmin } from "../../design/guards/useRole";
import { useJobEdit } from "../../lib/data/hooks/useJobEdit";
import { JobOverviewTab } from "../../components/job/overview";
import { JobNotesTab } from "../../components/job/notes";
import { JobPhotosTab } from "../../components/job/photos";
import { JobTimeTab } from "../../components/job/time";
import { JobTodayCard } from "../../components/job/today-card";
import { AutoClockStatus } from "../../components/job/auto-clock-status";
import { JobPlantUsage } from "../../components/job/plant-usage";
import { JobSignatureTab } from "../../components/job/signature";
import { JobDocumentsTab } from "../../components/job/documents";
import { JobVariationsTab } from "../../components/job/variations";
import { JobSupplierOrdersTab } from "../../components/job/supplier-orders";
import { ScheduleJobModal } from "../../components/job/schedule-job-modal";
import { getJobStageLabel } from "../../lib/job-stages";
import { formatScheduleSummary } from "../../lib/scheduleDisplay";
import { getJobCostCentres, type JobCostCentre } from "../../lib/data/reads/jobBilling";
import { listJobBookings, type JobBooking } from "../../lib/data/reads/bookings";
import { bookingWindow, mergePendingBookings } from "../../lib/bookings";
import { useDataLayer } from "../../lib/data/DataProvider";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "time", label: "Time" },
  { key: "variations", label: "Variations" },
  { key: "orders", label: "Orders" },
  { key: "photos", label: "Photos" },
  { key: "documents", label: "Documents" },
  { key: "notes", label: "Notes" },
  { key: "signature", label: "Signature" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

// Tabs that still make sense read-only. Time, Variations and Signature are
// all actions, so they are hidden rather than shown disabled. Orders stays:
// any tech may raise a supplier PO on any job (Justin, 28 Oct 2026) — it goes
// through the web API, not a job write the database would refuse.
const VIEW_ONLY_TABS = new Set<TabKey>(["overview", "orders", "photos", "documents", "notes"]);

const JOB_STATUSES = ["pending", "scheduled", "in_progress", "on_hold", "completed", "cancelled"] as const;
const JOB_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const JOB_TYPES = ["service", "installation", "maintenance", "emergency", "quote", "project"] as const;

export default function JobDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const isOfficeOrAdmin = useIsOfficeOrAdmin();
  const jobEdit = useJobEdit();
  const [job, setJob] = useState<any>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [tab, setTab] = useState<TabKey>("overview");
  const [editing, setEditing] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);
  const [details, setDetails] = useState<{ title: string; description: string } | null>(null);
  // Latest stage note's stage only (not the full note history — that's the
  // Notes tab's job) — just enough for a header badge showing where the last
  // person left off. Best-effort: left null (badge simply doesn't render) if
  // offline or the query fails, same tolerance as the Notes tab's own read.
  const [currentStage, setCurrentStage] = useState<string | null>(null);
  // Stage picker options for the Schedule modal — same read the Time tab
  // already uses, loaded here so the modal has it before it opens.
  const [costCenters, setCostCenters] = useState<JobCostCentre[]>([]);
  // The job's full crew (migration 0059, job_assignments) — a deliberate
  // separate, ad-hoc query rather than widening getJob()/JobDetail, whose
  // local/remote read parity contract this screen must not destabilize.
  // Mirrors the same pattern already used in (office)/schedule.tsx.
  const [assignedStaff, setAssignedStaff] = useState<{ id: string; full_name: string }[]>([]);
  // Whether assignedStaff came from a successful read. View-only mode needs a
  // POSITIVE answer that the tech is not on the crew; offline or on a failed
  // read the screen stays editable, so a tech's own job never locks up.
  const [assignmentKnown, setAssignmentKnown] = useState(false);
  // The job's bookings (migration 0079 yet): who works
  // it, when, and against which cost centre. NULL until bookings exist (or
  // when they could not be read) — the header then shows the job-level
  // schedule as before.
  const [bookings, setBookings] = useState<JobBooking[] | null>(null);
  const layer = useDataLayer();

  // Best-effort like the crew and cost centres: bookings are detail on top of
  // the job, never a reason to fail the screen. Edits still queued in the
  // outbox are kept (mergePendingBookings), because the device mirror only
  // learns about a booking once it has synced.
  const refreshBookings = useCallback(async () => {
    try {
      const read = await listJobBookings(id);
      if (!read) {
        setBookings(null);
        return;
      }
      const pending = layer ? await layer.outbox.pendingRowIds() : new Set<string>();
      setBookings((shown) => mergePendingBookings(shown ?? [], read, pending));
    } catch (e) {
      console.warn("[job] bookings unavailable; showing the job's own schedule:", e);
    }
  }, [id, layer]);

  const refreshAssignedStaff = useCallback(async () => {
    try {
      const { data, error: assignmentError } = await supabase
        .from("job_assignments")
        .select("staff_id, profiles(full_name)")
        .eq("job_id", id);
      if (assignmentError) throw assignmentError;
      setAssignedStaff(
        (data ?? []).map((a: any) => ({ id: a.staff_id, full_name: a.profiles?.full_name ?? "" }))
      );
      setAssignmentKnown(true);
    } catch {
      setAssignedStaff([]); // Best-effort, same tolerance as costCenters/currentStage above.
      setAssignmentKnown(false);
    }
  }, [id]);

  // Both awaits can throw — the session lookup and the row read. Uncaught, the
  // throw skipped setLoading(false) and the technician sat on a spinner that
  // never resolved, on the one screen they spend the whole day in.
  const loadJob = useCallback(async () => {
    try {
      setError(null);
      const {
        data: { user },
      } = await supabase.auth.getUser();
      setUserId(user?.id ?? null);

      setJob(await getJob(id));

      try {
        setCostCenters(await getJobCostCentres(id));
      } catch {
        setCostCenters([]); // Best-effort, same tolerance as the Time tab's own load.
      }

      await refreshAssignedStaff();
      await refreshBookings();

      try {
        const { data: latestStageNote } = await supabase
          .from("job_stage_notes")
          .select("stage")
          .eq("job_id", id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        setCurrentStage(latestStageNote?.stage ?? null);
      } catch {
        setCurrentStage(null); // Offline or query failure — non-fatal, badge just won't show.
      }
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [id, refreshAssignedStaff, refreshBookings]);

  useFocusEffect(
    useCallback(() => {
      void loadJob();
    }, [loadJob])
  );

  // Office/admin quick-edit of a job's own fields (offline-durable, preserve-on-
  // update). Applies the change optimistically; completion is still owned by the
  // sign-off flow — this is for dispatch/triage edits, not customer/site
  // reassignment (a heavier flow still done on the web).
  const applyEdit = useCallback(
    async (fields: { status?: string; priority?: string; jobType?: string }, close = true) => {
      if (savingEdit || !jobEdit.ready) return;
      setSavingEdit(true);
      try {
        await jobEdit.updateFields(id, fields);
        // Map camelCase inputs back onto the job row's snake_case columns.
        setJob((j: any) => ({ ...j, ...(fields.status !== undefined && { status: fields.status }), ...(fields.priority !== undefined && { priority: fields.priority }), ...(fields.jobType !== undefined && { job_type: fields.jobType }) }));
        if (close) setEditing(false);
      } catch (e) {
        Alert.alert("Couldn't update", e instanceof Error ? e.message : "Please try again.");
      } finally {
        setSavingEdit(false);
      }
    },
    [id, jobEdit, savingEdit]
  );

  const openEdit = useCallback(() => {
    setDetails({ title: job?.title ?? "", description: job?.description ?? "" });
    setEditing(true);
  }, [job]);

  // Save the free-text title/description together (only the changed fields go to
  // the outbox). Title is required; a blank title is rejected.
  const saveDetails = useCallback(async () => {
    if (!details || savingEdit || !jobEdit.ready || !job) return;
    const title = details.title.trim();
    if (!title) { Alert.alert("Title required", "A job title can't be empty."); return; }
    const description = details.description.trim();
    const fields: { title?: string; description?: string | null } = {};
    if (title !== job.title) fields.title = title;
    if (description !== (job.description ?? "")) fields.description = description || null;
    if (Object.keys(fields).length === 0) return;
    setSavingEdit(true);
    try {
      await jobEdit.updateFields(id, fields);
      setJob((j: any) => ({ ...j, ...fields }));
    } catch (e) {
      Alert.alert("Couldn't update", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setSavingEdit(false);
    }
  }, [details, id, job, jobEdit, savingEdit]);

  if (loading) {
    return (
      <SafeAreaView style={styles.center} edges={["bottom", "left", "right"]}>
        <ActivityIndicator size="large" color={colors.blue600} />
      </SafeAreaView>
    );
  }
  // Checked BEFORE the !job branch. A read that threw is a failure, not an
  // absence, and reporting it as "Job not found." would send a technician who is
  // standing at the site looking for a job that was never gone.
  if (error) {
    return (
      <SafeAreaView style={styles.container} edges={["bottom", "left", "right"]}>
        <ScreenError error={error} onRetry={() => { setLoading(true); void loadJob(); }} />
      </SafeAreaView>
    );
  }
  // The read succeeded and still returned no row → genuinely removed, or not
  // visible to this user. Offline no longer lands here: it throws, and the
  // branch above says so.
  if (!job) {
    return (
      <SafeAreaView style={styles.center} edges={["bottom", "left", "right"]}>
        <Text style={styles.notFound}>Job not found.</Text>
        <Text style={styles.notFoundHint}>It may have been removed, or you may not have access.</Text>
        <TouchableOpacity style={styles.notFoundBtn} onPress={() => router.back()}>
          <Text style={styles.notFoundBtnText}>Go back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  // A technician on a job they are not assigned to (opened from Search) may
  // look but not change anything. The database refuses it (migration 0074),
  // and a refused write would otherwise sit failed in the outbox.
  const viewOnly =
    !isOfficeOrAdmin && assignmentKnown && !!userId && !assignedStaff.some((a) => a.id === userId);
  const visibleTabs = viewOnly ? TABS.filter((t) => VIEW_ONLY_TABS.has(t.key)) : TABS;
  const activeTab: TabKey = visibleTabs.some((t) => t.key === tab) ? tab : "overview";

  const sc = statusColors[job.status] ?? statusColors.pending;

  return (
    <SafeAreaView style={styles.container} edges={["bottom", "left", "right"]}>
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          #{job.job_number} — {job.title}
        </Text>
        {isOfficeOrAdmin && (
          <TouchableOpacity style={styles.scheduleBtn} onPress={() => setScheduleOpen(true)} accessibilityLabel="Schedule job">
            <Ionicons name="calendar-outline" size={14} color="#fff" />
            <Text style={styles.scheduleText}>Schedule</Text>
          </TouchableOpacity>
        )}
        {isOfficeOrAdmin && (
          <TouchableOpacity style={styles.billingBtn} onPress={() => router.push(`/job/${id}/billing`)} accessibilityLabel="Job billing">
            <Ionicons name="cash-outline" size={14} color={colors.blue600} />
            <Text style={styles.billingText}>Billing</Text>
          </TouchableOpacity>
        )}
        {isOfficeOrAdmin ? (
          <TouchableOpacity style={[styles.badge, styles.badgeEditable, { backgroundColor: sc.bg }]} onPress={openEdit} accessibilityLabel="Edit job">
            <Text style={[styles.badgeText, { color: sc.text }]}>{job.status.replace("_", " ")}</Text>
            <Ionicons name="chevron-down" size={11} color={sc.text} />
          </TouchableOpacity>
        ) : (
          <View style={[styles.badge, { backgroundColor: sc.bg }]}>
            <Text style={[styles.badgeText, { color: sc.text }]}>{job.status.replace("_", " ")}</Text>
          </View>
        )}
        {currentStage && (
          <View style={[styles.badge, { backgroundColor: colors.blue100 }]}>
            <Text style={[styles.badgeText, { color: colors.blue600 }]}>Stage: {getJobStageLabel(currentStage)}</Text>
          </View>
        )}
      </View>
      <Text style={styles.subtitle}>
        {job.customers?.name}
        {job.sites ? ` · ${job.sites.name}, ${job.sites.suburb}` : ""}
      </Text>
      {bookings && bookings.length > 0 ? (
        // One line per booking — who, when, which stage; your own in blue.
        <View style={styles.bookingList}>
          {bookings.map((b) => {
            const mine = !!userId && b.staff_id === userId;
            const stage = b.cost_center_id ? costCenters.find((cc) => cc.id === b.cost_center_id)?.name : null;
            return (
              <Text key={b.id} style={[styles.scheduleSubtitle, mine && styles.myBooking]} numberOfLines={2}>
                {mine ? "You" : (b.staff_name ?? "Unassigned")} · {formatScheduleSummary(bookingWindow(b))}
                {stage ? ` · ${stage}` : ""}
              </Text>
            );
          })}
        </View>
      ) : (
        <Text style={styles.scheduleSubtitle}>
        {assignedStaff.length > 0 && job.scheduled_start && job.schedule_daily
          ? // Multi-day (0071): the range and the hours worked on each day.
            `${assignedStaff.map((a) => a.full_name).join(", ")} · ${formatScheduleSummary(job)}`
          : assignedStaff.length > 0 && job.scheduled_start
          ? `${assignedStaff.map((a) => a.full_name).join(", ")} · ${new Date(job.scheduled_start).toLocaleString("en-AU", {
              weekday: "short",
              day: "numeric",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
              timeZone: "Australia/Melbourne",
            })}`
          : "Not scheduled"}
      </Text>
      )}

      <View style={styles.tabBarWrap}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabBar}>
          {visibleTabs.map((t) => (
            <TouchableOpacity key={t.key} style={[styles.tab, activeTab === t.key && styles.tabActive]} onPress={() => setTab(t.key)}>
              <Text style={[styles.tabText, activeTab === t.key && styles.tabTextActive]}>{t.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* automaticallyAdjustKeyboardInsets: iOS scrolls the field being typed in
          above the keyboard — it used to sit behind it (Justin, 21 Oct 2026,
          logging a variation). Every form ScrollView in the app has it. */}
      <ScrollView automaticallyAdjustKeyboardInsets keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled" style={styles.content} contentContainerStyle={{ paddingBottom: 40 }}>
        {viewOnly && (
          <View style={styles.viewOnlyBanner}>
            <Text style={styles.viewOnlyText}>View only — you're not assigned to this job.</Text>
          </View>
        )}
        {/* The day's steps first (Stage 6): what's done and what's next. Not in view-only. */}
        {activeTab === "overview" && !viewOnly && userId && (
          <JobTodayCard
            jobId={job.id}
            currentUserId={userId}
            signedOff={job.status === "completed"}
            scheduledCostCenterId={job.scheduled_cost_center_id}
            myBookings={bookings ? bookings.filter((b) => b.staff_id === userId) : null}
            onGo={setTab}
          />
        )}
        {activeTab === "overview" && <JobOverviewTab job={job} currentUserId={userId} readOnly={viewOnly} onChanged={loadJob} />}
        {activeTab === "time" && userId && <AutoClockStatus />}
        {activeTab === "time" && userId && (
          <JobTimeTab
            jobId={job.id}
            currentUserId={userId}
            scheduledCostCenterId={job.scheduled_cost_center_id}
            myBookings={bookings ? bookings.filter((b) => b.staff_id === userId) : null}
          />
        )}
        {/* Truck & plant (Stage 7): the driver logs cartage against the job's cost centre. */}
        {activeTab === "time" && userId && <JobPlantUsage jobId={job.id} />}
        {activeTab === "variations" && userId && <JobVariationsTab jobId={job.id} currentUserId={userId} />}
        {activeTab === "orders" && <JobSupplierOrdersTab jobId={job.id} costCentres={costCenters} />}
        {activeTab === "photos" && userId && (
          <JobPhotosTab
            jobId={job.id}
            currentUserId={userId}
            jobNumber={job.job_number}
            siteLabel={job.sites ? `${job.sites.address_line1}, ${job.sites.suburb}` : null}
            readOnly={viewOnly}
          />
        )}
        {activeTab === "documents" && <JobDocumentsTab jobId={job.id} />}
        {activeTab === "notes" && userId && <JobNotesTab jobId={job.id} currentUserId={userId} readOnly={viewOnly} />}
        {activeTab === "signature" && userId && (
          <JobSignatureTab
            jobId={job.id}
            currentUserId={userId}
            existingSignature={job.status === "completed" ? job.completion_notes : null}
            existingVoiceTranscript={job.voice_report_transcript}
            onCompleted={loadJob}
          />
        )}
      </ScrollView>

      <Modal visible={editing} transparent animationType="slide" onRequestClose={() => !savingEdit && setEditing(false)}>
        <View style={styles.overlay}>
          <ScrollView automaticallyAdjustKeyboardInsets keyboardDismissMode="interactive" style={styles.sheetScroll} contentContainerStyle={styles.sheet} keyboardShouldPersistTaps="handled">
            <Text style={styles.sheetTitle}>Update job</Text>

            <Text style={styles.sheetLabel}>Title</Text>
            <TextInput
              style={styles.input}
              value={details?.title ?? ""}
              onChangeText={(v) => setDetails((d) => d && { ...d, title: v })}
              placeholder="Job title"
              placeholderTextColor={colors.slate400}
            />

            <Text style={styles.sheetLabel}>Status</Text>
            <View style={styles.chipWrap}>
              {JOB_STATUSES.map((s) => {
                const c = statusColors[s] ?? statusColors.pending;
                const active = job.status === s;
                return (
                  <TouchableOpacity key={s} style={[styles.chip, active && { backgroundColor: c.bg, borderColor: c.text }]} onPress={() => applyEdit({ status: s }, false)} disabled={savingEdit}>
                    <Text style={[styles.chipText, active && { color: c.text }]}>{s.replace("_", " ")}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={styles.sheetLabel}>Priority</Text>
            <View style={styles.chipWrap}>
              {JOB_PRIORITIES.map((p) => {
                const active = job.priority === p;
                return (
                  <TouchableOpacity key={p} style={[styles.chip, active && styles.chipActive]} onPress={() => applyEdit({ priority: p }, false)} disabled={savingEdit}>
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{p}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={styles.sheetLabel}>Type</Text>
            <View style={styles.chipWrap}>
              {JOB_TYPES.map((t) => {
                const active = job.job_type === t;
                return (
                  <TouchableOpacity key={t} style={[styles.chip, active && styles.chipActive]} onPress={() => applyEdit({ jobType: t }, false)} disabled={savingEdit}>
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{t}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            <Text style={styles.sheetLabel}>Description</Text>
            <TextInput
              style={[styles.input, styles.inputMultiline]}
              value={details?.description ?? ""}
              onChangeText={(v) => setDetails((d) => d && { ...d, description: v })}
              placeholder="Job description"
              placeholderTextColor={colors.slate400}
              multiline
            />

            <Text style={styles.editHint}>Status, priority and type save instantly. Customer and site are edited on the web.</Text>

            <View style={styles.editActions}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setEditing(false)} disabled={savingEdit}>
                <Text style={styles.cancelText}>Close</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.doneBtn} onPress={saveDetails} disabled={savingEdit}>
                <Text style={styles.doneText}>{savingEdit ? "…" : "Save details"}</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </Modal>

      <ScheduleJobModal
        visible={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        jobId={job.id}
        jobStatus={job.status}
        currentAssignedIds={assignedStaff.map((a) => a.id)}
        currentUserId={userId ?? ""}
        currentScheduledStart={job.scheduled_start}
        currentScheduledEnd={job.scheduled_end}
        currentScheduleDaily={!!job.schedule_daily}
        currentScheduleAllDay={!!job.schedule_all_day}
        costCenters={costCenters}
        currentScheduledCostCenterId={job.scheduled_cost_center_id}
        bookings={bookings}
        onBookingsChanged={(next) => {
          setBookings(next);
          // The crew follows the bookings server-side; re-read it once synced.
          void refreshAssignedStaff();
        }}
        onScheduled={(patch) => {
          setJob((j: any) => ({ ...j, ...patch }));
          void refreshAssignedStaff();
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  viewOnlyBanner: { margin: 12, marginBottom: 0, padding: 10, borderRadius: 10, backgroundColor: colors.blue100 },
  viewOnlyText: { fontSize: 13, fontWeight: "600", color: colors.blue600, textAlign: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg, padding: 24 },
  notFound: { fontSize: 16, fontWeight: "700", color: colors.slate900 },
  notFoundHint: { fontSize: 13, color: colors.slate500, textAlign: "center", marginTop: 6 },
  notFoundBtn: { marginTop: 16, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10, backgroundColor: colors.blue600 },
  notFoundBtnText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 12,
    gap: 8,
  },
  title: { fontSize: 17, fontWeight: "700", color: colors.slate900, flex: 1 },
  billingBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, borderWidth: 1, borderColor: colors.blue100, backgroundColor: colors.blue100 },
  billingText: { fontSize: 12, fontWeight: "700", color: colors.blue600 },
  scheduleBtn: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, backgroundColor: colors.blue600 },
  scheduleText: { fontSize: 12, fontWeight: "700", color: "#fff" },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  badgeEditable: { flexDirection: "row", alignItems: "center", gap: 3 },
  badgeText: { fontSize: 11, fontWeight: "600", textTransform: "capitalize" },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheetScroll: { maxHeight: "88%", flexGrow: 0 },
  sheet: { backgroundColor: colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, paddingBottom: 28 },
  sheetTitle: { fontSize: 16, fontWeight: "800", color: colors.slate900, marginBottom: 8 },
  sheetLabel: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginTop: 12, marginBottom: 8 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, backgroundColor: colors.bg, color: colors.slate900 },
  inputMultiline: { minHeight: 72, textAlignVertical: "top" },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  chipActive: { backgroundColor: colors.blue600, borderColor: colors.blue600 },
  chipText: { fontSize: 13, fontWeight: "600", color: colors.slate700, textTransform: "capitalize" },
  chipTextActive: { color: "#fff" },
  editHint: { fontSize: 11, color: colors.slate400, marginTop: 14 },
  editActions: { flexDirection: "row", gap: 10, marginTop: 14 },
  cancelBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.bg, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  cancelText: { color: colors.slate700, fontWeight: "600", fontSize: 14 },
  doneBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.blue600, alignItems: "center" },
  doneText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  subtitle: { fontSize: 13, color: colors.slate500, paddingHorizontal: 16, marginTop: 2 },
  scheduleSubtitle: { fontSize: 12, color: colors.slate400, paddingHorizontal: 16, marginTop: 2 },
  bookingList: { marginTop: 2 },
  myBooking: { color: colors.blue600, fontWeight: "700" },
  tabBarWrap: { borderBottomWidth: 1, borderBottomColor: colors.border, marginTop: 12 },
  tabBar: { paddingHorizontal: 12, gap: 4 },
  tab: { paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 2, borderBottomColor: "transparent" },
  tabActive: { borderBottomColor: colors.blue600 },
  tabText: { fontSize: 13, fontWeight: "600", color: colors.slate500 },
  tabTextActive: { color: colors.blue600 },
  content: { flex: 1 },
});
