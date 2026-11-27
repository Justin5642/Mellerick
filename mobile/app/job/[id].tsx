import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Alert, TextInput } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { jobBackTarget } from "../../lib/jobBack";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../lib/supabase";
import { getJob } from "../../lib/data/reads/jobs";
import { colors, statusColors } from "../../lib/theme";
import { ScreenError } from "../../design/components/ScreenError";
import { useIsOfficeOrAdmin } from "../../design/guards/useRole";
import { RoleGate } from "../../design/guards/RoleGate";
import { copyJob, copyJobTitle, deleteJob, deleteJobMessage } from "../../lib/officeActions";
import * as Crypto from "expo-crypto";
import { useJobEdit } from "../../lib/data/hooks/useJobEdit";
import { JobOverviewTab } from "../../components/job/overview";
import { SentBackBanner } from "../../components/job/sent-back-banner";
import { JobNotesTab } from "../../components/job/notes";
import { JobPhotosTab } from "../../components/job/photos";
import { JobTimeTab } from "../../components/job/time";
import { JobTodayCard } from "../../components/job/today-card";
import { MyBookingsDidntMakeIt } from "../../components/job/didnt-make-it";
import { useMissedFlags } from "../../lib/data/hooks/useMissedFlags";
import { isMissed, missedTagText, withQueuedMissed } from "../../lib/bookingAttendance";
import { StartWorkButton } from "../../components/job/start-work";
import { AutoClockStatus } from "../../components/job/auto-clock-status";
import { JobPlantUsage } from "../../components/job/plant-usage";
import { JobSignatureTab } from "../../components/job/signature";
import { isMultiDay } from "../../lib/jobStages";
import { JobDocumentsTab } from "../../components/job/documents";
import { JobVariationsTab } from "../../components/job/variations";
import { JobSupplierOrdersTab } from "../../components/job/supplier-orders";
import { JobDayWorksTab } from "../../components/job/day-works";
import { JobPurchaseOrdersTab } from "../../components/job/purchase-orders";
import { JobMistakesTab } from "../../components/job/mistakes";
import { ScheduleJobModal } from "../../components/job/schedule-job-modal";
import { isJobClosedForScheduling } from "../../lib/jobSchedulable";
import { parseSchedulePrefill, type SchedulePrefill } from "../../lib/scheduleExistingJob";
import { KeyboardSheet, KEYBOARD_SHEET_INPUT_FONT_SIZE } from "../../components/KeyboardSheet";
import { getJobStageLabel } from "../../lib/job-stages";
import { formatScheduleSummary, businessTodayKey } from "../../lib/scheduleDisplay";
import { getJobCostCentres, type JobCostCentre } from "../../lib/data/reads/jobBilling";
import { listJobBookings, type JobBooking } from "../../lib/data/reads/bookings";
// Staff leave (migration 0112 — a draft, not applied yet), online only: a
// booking on its technician's leave day is flagged "Needs reassigning".
import { listScheduleLeave } from "../../lib/data/reads/leave";
import { bookingsNeedingReassignment, leaveDateLabel, leaveDayLabel, NEEDS_REASSIGNING, type ScheduleLeave } from "../../lib/staffLeave";
import { shiftDateKey } from "../../lib/date";
import { bookingWindow, mergePendingBookings } from "../../lib/bookings";
import { useDataLayer } from "../../lib/data/DataProvider";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "time", label: "Time" },
  { key: "dayworks", label: "Day Works" },
  { key: "variations", label: "Variations" },
  { key: "orders", label: "Orders" },
  { key: "pos", label: "POs" },
  { key: "mistakes", label: "Mistakes" },
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
// On a job they are not on, a technician looks up the plans: no Notes (office
// chatter, scheduling notes) and no schedule anywhere (Justin, 16 Nov 2026).
const VIEW_ONLY_TABS = new Set<TabKey>(["overview", "orders", "photos", "documents"]);

// Day Works / Hire (Stage 2, Nov 2026): only for the job's crew and the office
// — the server's requireOnJob refuses anyone else — and never on a view-only
// job (it is not in VIEW_ONLY_TABS). Online only; offline it says it needs signal.
// Mistakes (0119, a draft not applied yet) follow the same rule: on the job (or office), never view-only.

const JOB_STATUSES = ["pending", "scheduled", "in_progress", "on_hold", "completed", "cancelled"] as const;
const JOB_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const JOB_TYPES = ["service", "installation", "maintenance", "emergency", "quote", "project"] as const;

export default function JobDetailScreen() {
  const { id, schedule: scheduleParam, tech: techParam, day: dayParam } = useLocalSearchParams<{ id: string; schedule?: string; tech?: string; day?: string }>();
  const router = useRouter();
  const navigation = useNavigation();
  const isOfficeOrAdmin = useIsOfficeOrAdmin();

  // Always a way out (lib/jobBack.ts): the native arrow only appears when a
  // screen sits behind this one, and a job opened from a notification or after
  // a role re-gate has none.
  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: () => (
        <TouchableOpacity
          onPress={() => {
            const target = jobBackTarget(router.canGoBack(), isOfficeOrAdmin);
            if (target.kind === "pop") router.back();
            else router.replace(target.path);
          }}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          style={styles.headerBack}
        >
          <Ionicons name="chevron-back" size={24} color={colors.blue600} />
          <Text style={styles.headerBackText}>Back</Text>
        </TouchableOpacity>
      ),
    });
  }, [navigation, router, isOfficeOrAdmin]);
  const jobEdit = useJobEdit();
  const [job, setJob] = useState<any>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [tab, setTab] = useState<TabKey>("overview");
  const [editing, setEditing] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  // `?schedule=1&tech=&day=` — the Schedule tab's "Schedule an existing job"
  // (20 Nov 2026): open the Schedule Job sheet once the job has loaded, with a
  // new booking for that technician and day. Office/admin only; used once.
  const [schedulePrefill, setSchedulePrefill] = useState<SchedulePrefill | null>(null);
  const scheduleParamUsed = useRef(false);
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
  useEffect(() => {
    if (scheduleParamUsed.current || scheduleParam !== "1" || !isOfficeOrAdmin || !job || loading) return;
    scheduleParamUsed.current = true;
    if (isJobClosedForScheduling(job.status)) return;
    // Any active technician id: the sheet's own staff list decides who can be ticked.
    const ids = techParam ? [techParam] : [];
    setSchedulePrefill(parseSchedulePrefill(techParam ?? null, dayParam ?? null, ids));
    setScheduleOpen(true);
  }, [scheduleParam, techParam, dayParam, isOfficeOrAdmin, job, loading]);
  const [leave, setLeave] = useState<ScheduleLeave[]>([]);
  const layer = useDataLayer();
  const { queued: queuedMissed } = useMissedFlags();

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
      // Leave from today for a year, only when there are bookings to check.
      // Offline or before 0112: nothing flagged, nothing else changes.
      if (read.length > 0) {
        const today = businessTodayKey();
        const res = await listScheduleLeave(today, shiftDateKey(today, 366));
        if (res.available) setLeave(res.leave);
      }
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
  // Re-read the job's cost centres whenever a tab that uses them opens: they
  // were read once with the job, so one the office added since never showed
  // (2 Nov 2026). A local read, so it costs nothing to repeat.
  useEffect(() => {
    if (tab !== "time" && tab !== "orders") return;
    getJobCostCentres(id)
      .then(setCostCenters)
      .catch(() => {});
  }, [tab, id]);

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

  // Admin only (the route's requireAdmin decides; the button sits in a
  // RoleGate): the web's Delete job, same wording and rules, through
  // DELETE /api/jobs/[id]. Online — a refusal (a linked quote or invoice)
  // is answered here, never left to dead-letter in the queue.
  const [deleting, setDeleting] = useState(false);
  // "Copy job" (20 Nov 2026; office/admin — RoleGate, and the route checks):
  // a new job from this one as a template, then open it. Online only.
  const [copying, setCopying] = useState(false);
  const copyIdRef = useRef<string | null>(null);
  const confirmCopy = useCallback(() => {
    if (!job || copying) return;
    setEditing(false);
    const title = copyJobTitle(job.title ?? "");
    setTimeout(() => {
      Alert.alert(
        `Copy job #${job.job_number}?`,
        `A new job "${title}" for the same customer and site, with the same type, priority, description and cost centres (hours, no money). Bookings, time, photos, notes and documents are not copied. You can rename it afterwards.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Copy job",
            onPress: async () => {
              setCopying(true);
              // One id per copy attempt, kept across a retry of the same one.
              copyIdRef.current = copyIdRef.current ?? Crypto.randomUUID();
              try {
                const copied = await copyJob(job.id, title, copyIdRef.current);
                copyIdRef.current = null;
                if (copied.warning) Alert.alert("Job copied", copied.warning);
                router.push(`/job/${copied.id}`);
              } catch (e) {
                Alert.alert("Couldn't copy the job", e instanceof Error ? e.message : "Please try again.");
              } finally {
                setCopying(false);
              }
            },
          },
        ]
      );
    }, 450);
  }, [job, copying, router]);
  const confirmDelete = useCallback(() => {
    if (!job || deleting) return;
    setEditing(false);
    // After the sheet has slid away: iOS will not show an alert over a modal
    // that is still dismissing.
    setTimeout(() => {
      Alert.alert(`Delete job #${job.job_number}?`, deleteJobMessage(job.title), [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete Job",
          style: "destructive",
          onPress: async () => {
            setDeleting(true);
            try {
              await deleteJob(job.id);
              router.replace("/jobs");
            } catch (e) {
              Alert.alert("Couldn't delete the job", e instanceof Error ? e.message : "Please try again.");
            } finally {
              setDeleting(false);
            }
          },
        },
      ]);
    }, 450);
  }, [job, deleting, router]);

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
        <TouchableOpacity
          style={styles.notFoundBtn}
          onPress={() => {
            const target = jobBackTarget(router.canGoBack(), isOfficeOrAdmin);
            if (target.kind === "pop") router.back();
            else router.replace(target.path);
          }}
        >
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
  // On the job: office, the lead (jobs.assigned_to — known offline too) or the crew.
  const onJob =
    isOfficeOrAdmin || (!!userId && (job.assigned_to === userId || assignedStaff.some((a) => a.id === userId)));
  const visibleTabs = (viewOnly ? TABS.filter((t) => VIEW_ONLY_TABS.has(t.key)) : TABS).filter(
    (t) => (t.key !== "dayworks" || onJob) && (t.key !== "mistakes" || onJob) && (t.key !== "pos" || isOfficeOrAdmin)
  );
  const activeTab: TabKey = visibleTabs.some((t) => t.key === tab) ? tab : "overview";

  const sc = statusColors[job.status] ?? statusColors.pending;

  return (
    <SafeAreaView style={styles.container} edges={["bottom", "left", "right"]}>
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          #{job.job_number} — {job.title}
        </Text>
        {isOfficeOrAdmin && (
          // A completed/cancelled job is off the Schedule tab, so it is not
          // offered as schedulable: the button is greyed and opens the sheet
          // that explains why, with a way to change the status first.
          <TouchableOpacity
            style={[styles.scheduleBtn, isJobClosedForScheduling(job.status) && styles.scheduleBtnClosed]}
            onPress={() => setScheduleOpen(true)}
            accessibilityLabel={isJobClosedForScheduling(job.status) ? `Schedule job — not available, the job is ${job.status}` : "Schedule job"}
          >
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
      {viewOnly ? null : bookings && bookings.length > 0 ? (
        // One line per booking — who, when, which stage; your own in blue.
        <View style={styles.bookingList}>
          {(() => {
            const flagged = bookingsNeedingReassignment(bookings, leave, businessTodayKey());
            return bookings.map((raw) => {
              // "Didn't make it" (0121), with a change still queued on this phone laid over it.
              const b = withQueuedMissed(raw, queuedMissed.get(raw.id));
              const mine = !!userId && b.staff_id === userId;
              const stage = b.cost_center_id ? costCenters.find((cc) => cc.id === b.cost_center_id)?.name : null;
              const clash = flagged.get(b.id);
              return (
                <View key={b.id}>
                  <Text style={[styles.scheduleSubtitle, mine && styles.myBooking]} numberOfLines={2}>
                    {mine ? "You" : (b.staff_name ?? "Unassigned")} · {formatScheduleSummary(bookingWindow(b))}
                    {stage ? ` · ${stage}` : ""}
                  </Text>
                  {isMissed(b) ? (
                    <Text style={styles.reassignLine} numberOfLines={2}>
                      {missedTagText(b)}
                    </Text>
                  ) : null}
                  {clash ? (
                    <Text style={styles.reassignLine} numberOfLines={2} accessibilityLabel={`${NEEDS_REASSIGNING}: on leave`}>
                      {NEEDS_REASSIGNING} · {clash.map((c) => `${leaveDayLabel(c.leaveDay)} ${leaveDateLabel(c.dateKey)}`).join(", ")}
                    </Text>
                  ) : null}
                </View>
              );
            });
          })()}
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
        {/* Sent back by the office (0122): the crew and office, never view-only. */}
        {!viewOnly && <SentBackBanner job={job} />}
        {/* Popped in to do something (25 Nov 2026): book themselves on from
            now and clock on to the stage they pick — online, technicians on
            an open job they're not on. Overview only, like the Today card. */}
        {viewOnly && activeTab === "overview" && userId && !isJobClosedForScheduling(job.status) && (
          <StartWorkButton
            jobId={job.id}
            jobNumber={job.job_number ?? null}
            currentUserId={userId}
            onStarted={(booking) => {
              // On the crew now (0079 did it on the server): the full tabs at
              // once — the job reaches this phone's mirror with the next sync.
              setAssignedStaff((prev) => (prev.some((a) => a.id === userId) ? prev : [...prev, { id: userId, full_name: "You" }]));
              setBookings((prev) => [...(prev ?? []).filter((b) => b.id !== booking.id), { ...booking, note: null, staff_name: null }]);
              setTab("time");
            }}
          />
        )}
        {/* "Didn't make it" on their own bookings up to today (0121). Not in view-only. */}
        {activeTab === "overview" && !viewOnly && userId && (
          <MyBookingsDidntMakeIt
            jobId={job.id}
            jobStatus={job.status}
            bookings={bookings}
            currentUserId={userId}
            describe={(b) => formatScheduleSummary(bookingWindow(b)) ?? "Booking"}
          />
        )}
        {/* The day's steps first (Stage 6): what's done and what's next. Not in view-only. */}
        {activeTab === "overview" && !viewOnly && userId && (
          <JobTodayCard
            jobId={job.id}
            currentUserId={userId}
            signedOff={job.status === "completed"}
            multiDay={isMultiDay(job)}
            scheduledCostCenterId={job.scheduled_cost_center_id}
            myBookings={bookings ? bookings.filter((b) => b.staff_id === userId) : null}
            onGo={setTab}
          />
        )}
        {activeTab === "overview" && <JobOverviewTab
            job={viewOnly ? { ...job, scheduled_start: null, scheduled_end: null } : job}
            currentUserId={userId}
            readOnly={viewOnly}
            onChanged={loadJob}
            bookings={viewOnly ? null : bookings}
            isOffice={isOfficeOrAdmin}
          />}
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
        {activeTab === "dayworks" && userId && <JobDayWorksTab jobId={job.id} />}
        {activeTab === "variations" && userId && <JobVariationsTab jobId={job.id} currentUserId={userId} />}
        {activeTab === "orders" && <JobSupplierOrdersTab jobId={job.id} currentUserId={userId ?? null} costCentres={costCenters} />}
        {activeTab === "photos" && userId && (
          <JobPhotosTab
            jobId={job.id}
            currentUserId={userId}
            jobNumber={job.job_number}
            siteLabel={job.sites ? `${job.sites.address_line1}, ${job.sites.suburb}` : null}
            readOnly={viewOnly}
          />
        )}
        {activeTab === "pos" && isOfficeOrAdmin && <JobPurchaseOrdersTab jobId={job.id} />}
        {/* Log mistake (0119): the crew on the job, and office. No money; online only. */}
        {activeTab === "mistakes" && userId && onJob && <JobMistakesTab jobId={job.id} />}
        {activeTab === "documents" && <JobDocumentsTab jobId={job.id} />}
        {activeTab === "notes" && userId && <JobNotesTab jobId={job.id} currentUserId={userId} readOnly={viewOnly} canEditAll={isOfficeOrAdmin} />}
        {activeTab === "signature" && userId && (
          <JobSignatureTab
            jobId={job.id}
            currentUserId={userId}
            existingSignature={job.status === "completed" ? job.completion_notes : null}
            existingVoiceTranscript={job.voice_report_transcript}
            multiDay={isMultiDay(job)}
            myBookings={bookings ? bookings.filter((b) => b.staff_id === userId) : null}
            onCompleted={loadJob}
          />
        )}
      </ScrollView>

      <KeyboardSheet
        visible={editing}
        onRequestClose={() => !savingEdit && setEditing(false)}
        title={<Text style={styles.sheetTitle}>Update job</Text>}
        footer={
          <View style={styles.editActions}>
            <TouchableOpacity style={styles.cancelBtn} onPress={() => setEditing(false)} disabled={savingEdit}>
              <Text style={styles.cancelText}>Close</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.doneBtn} onPress={saveDetails} disabled={savingEdit}>
              <Text style={styles.doneText}>{savingEdit ? "…" : "Save details"}</Text>
            </TouchableOpacity>
          </View>
        }
      >
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

            <RoleGate roles={["office", "admin"]}>
              <TouchableOpacity style={styles.copyJobBtn} onPress={confirmCopy} disabled={copying || savingEdit} accessibilityLabel="Copy job">
                <Ionicons name="copy-outline" size={15} color={colors.blue600} />
                <Text style={styles.copyJobText}>{copying ? "Copying…" : "Copy job (use as a template)"}</Text>
              </TouchableOpacity>
            </RoleGate>
            <RoleGate roles={["admin"]}>
              <TouchableOpacity style={styles.deleteJobBtn} onPress={confirmDelete} disabled={deleting || savingEdit} accessibilityLabel="Delete job">
                <Ionicons name="trash-outline" size={15} color={colors.red600} />
                <Text style={styles.deleteJobText}>{deleting ? "Deleting…" : "Delete job"}</Text>
              </TouchableOpacity>
            </RoleGate>
      </KeyboardSheet>

      <ScheduleJobModal
        visible={scheduleOpen}
        onClose={() => {
          setScheduleOpen(false);
          setSchedulePrefill(null);
        }}
        prefill={schedulePrefill}
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
        onCostCentreAdded={() => {
          // Reaches the local mirror once it syncs; the sheet keeps the new line meanwhile.
          getJobCostCentres(job.id).then(setCostCenters).catch(() => {});
        }}
        bookings={bookings}
        onBookingsChanged={(next) => {
          setBookings(next);
          // The crew follows the bookings server-side; re-read it once synced.
          void refreshAssignedStaff();
        }}
        // After the schedule sheet has slid away: iOS will not present one
        // modal while another is still dismissing.
        onReopen={() => setTimeout(openEdit, 450)}
        onScheduled={(patch) => {
          setJob((j: any) => ({ ...j, ...patch }));
          void refreshAssignedStaff();
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  reassignLine: { fontSize: 12, fontWeight: "800", color: "#be123c", marginTop: 1 },
  container: { flex: 1, backgroundColor: colors.bg },
  headerBack: { flexDirection: "row", alignItems: "center", paddingRight: 8, marginLeft: -6 },
  headerBackText: { fontSize: 17, color: colors.blue600 },
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
  scheduleBtnClosed: { backgroundColor: colors.slate400 },
  scheduleText: { fontSize: 12, fontWeight: "700", color: "#fff" },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  badgeEditable: { flexDirection: "row", alignItems: "center", gap: 3 },
  badgeText: { fontSize: 11, fontWeight: "600", textTransform: "capitalize" },
  sheetTitle: { fontSize: 16, fontWeight: "800", color: colors.slate900, marginBottom: 8 },
  sheetLabel: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginTop: 12, marginBottom: 8 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: KEYBOARD_SHEET_INPUT_FONT_SIZE, backgroundColor: colors.bg, color: colors.slate900 },
  inputMultiline: { minHeight: 72, textAlignVertical: "top" },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  chipActive: { backgroundColor: colors.blue600, borderColor: colors.blue600 },
  chipText: { fontSize: 13, fontWeight: "600", color: colors.slate700, textTransform: "capitalize" },
  chipTextActive: { color: "#fff" },
  editHint: { fontSize: 11, color: colors.slate400, marginTop: 14 },
  copyJobBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 16, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: colors.blue100, backgroundColor: colors.bg },
  copyJobText: { color: colors.blue600, fontWeight: "700", fontSize: 13 },
  deleteJobBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, marginTop: 16, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: colors.red100, backgroundColor: colors.bg },
  deleteJobText: { fontSize: 13, fontWeight: "600", color: colors.red600 },
  editActions: { flexDirection: "row", gap: 10 },
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
