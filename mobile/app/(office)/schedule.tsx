import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, SectionList, StyleSheet, RefreshControl, Modal, TouchableOpacity, ActivityIndicator, Alert, Platform, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import DateTimePicker, { type DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { supabase } from "../../lib/supabase";
import { colors } from "../../lib/theme";
import { JobListRow } from "../../design/components/JobListRow";
import { ScreenError } from "../../design/components/ScreenError";
import { businessDayLabel, formatBusinessTime, computeRescheduleWithTime, localDateKey, toBusinessInputValue } from "../../lib/date";
import { moveSchedule, scheduleDays, type ScheduleDay } from "../../lib/scheduling";
import { formatScheduleSummary } from "../../lib/scheduleDisplay";
import { useSchedule } from "../../lib/data/hooks/useSchedule";
import { listAssignableStaff, type AssignableStaff } from "../../lib/data/reads/schedule";
import { unwrapRows } from "../../lib/data/reads/unwrap";

interface SchedJob {
  id: string;
  job_number: number;
  title: string;
  status: string;
  scheduled_start: string;
  scheduled_end: string | null;
  /** Migration 0071 — booked on each weekday of its range (lib/scheduling.ts). */
  schedule_daily?: boolean | null;
  schedule_all_day?: boolean | null;
  assigned_to: string | null;
  customers: { name: string } | null;
  profiles?: { full_name: string } | null;
}

/** One list row: a job on one of its booked days. */
interface SchedRow {
  job: SchedJob;
  day: ScheduleDay;
  index: number;
  count: number;
}

export default function ScheduleScreen() {
  const router = useRouter();
  const schedule = useSchedule();
  const [jobs, setJobs] = useState<SchedJob[]>([]);
  const [staff, setStaff] = useState<AssignableStaff[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [menuJob, setMenuJob] = useState<SchedJob | null>(null);
  const [reassignJob, setReassignJob] = useState<SchedJob | null>(null);
  const [datePickerFor, setDatePickerFor] = useState<SchedJob | null>(null);
  const [timePickerFor, setTimePickerFor] = useState<SchedJob | null>(null);
  const [pendingDate, setPendingDate] = useState<Date | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [staffError, setStaffError] = useState<unknown>(null);
  const [reassignAssigneeCount, setReassignAssigneeCount] = useState<number | null>(null);

  // Unwrapped rather than defaulted to []: this list's empty state is "Nothing
  // scheduled.", which an office user reads as the day being clear. A failed
  // read that renders it sends nobody to site.
  const load = useCallback(async () => {
    try {
      setError(null);
      const res = await supabase
        .from("jobs")
        .select("*, customers(name), profiles!jobs_assigned_to_fkey(full_name)")
        .not("scheduled_start", "is", null)
        .not("status", "in", '("completed","cancelled")')
        .order("scheduled_start");
      setJobs(unwrapRows(res as never, "ScheduleScreen.load") as unknown as SchedJob[]);
    } catch (e) {
      setError(e);
    }
  }, []);

  // The staff read is kept OUT of `error` on purpose: it only feeds the reassign
  // picker, and taking the whole schedule down because the technician list
  // failed would remove the working half of the screen. It was previously
  // `.catch(() => {})`, which left the picker looking like a business with no
  // technicians, so it now reports itself where those names are missing.
  const loadStaff = useCallback(() => {
    setStaffError(null);
    listAssignableStaff().then(setStaff, (e) => setStaffError(e));
  }, []);

  useEffect(() => {
    void load();
    loadStaff();
  }, [load, loadStaff]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // One row per booked DAY, not per job (migration 0071): a Mon–Wed daily job
  // appears under Monday, Tuesday and Wednesday with that day's hours, and
  // not under the weekend it skips. A single-day job is one row, as before.
  const sections = useMemo(() => {
    const rows = jobs
      .flatMap((job) => scheduleDays(job).map((day, index, all) => ({ job, day, index, count: all.length })))
      .sort((a, b) => a.day.startIso.localeCompare(b.day.startIso));
    const map = new Map<string, SchedRow[]>();
    for (const r of rows) {
      const arr = map.get(r.day.dateKey);
      if (arr) arr.push(r);
      else map.set(r.day.dateKey, [r]);
    }
    return Array.from(map, ([, data]) => ({ title: businessDayLabel(data[0].day.startIso), data }));
  }, [jobs]);

  // A job can have more than one technician (job_assignments, migration 0059)
  // even though this sheet only ever picks one. Reassigning here goes through
  // `assigned_to`, which the database collapses to that single pick — so
  // before showing the sheet, check whether this job currently has a crew and
  // warn that picking here will shrink it to one.
  function openReassign(job: SchedJob) {
    setReassignJob(job);
    setReassignAssigneeCount(null);
    supabase
      .from("job_assignments")
      .select("staff_id", { count: "exact", head: true })
      .eq("job_id", job.id)
      .then(({ count }) => setReassignAssigneeCount(count ?? null));
  }

  async function onReassign(assignedTo: string | null) {
    const job = reassignJob;
    if (!job || busy || !schedule.ready) return;
    setBusy(true);
    try {
      const tech = staff.find((s) => s.id === assignedTo);
      await schedule.reassign(job.id, assignedTo);
      // Optimistic: reflect the change immediately (the outbox syncs in the
      // background — offline, a server reload would show stale data).
      setJobs((cur) =>
        cur.map((j) => (j.id === job.id ? { ...j, assigned_to: assignedTo, profiles: assignedTo ? { full_name: tech?.full_name ?? "" } : null } : j))
      );
      setReassignJob(null);
    } catch (e) {
      Alert.alert("Couldn't reassign", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }

  // `time` is null for a daily job: it moves to start on `dateKey` keeping its
  // daily hours and its NUMBER OF BOOKED DAYS (moveSchedule — a Mon–Wed job
  // moved to Thursday becomes Thu, Fri, Mon). A continuous block takes the
  // picked date and time and keeps its duration, as before.
  async function applyReschedule(job: SchedJob, dateKey: string, time: { hour: number; minute: number } | null) {
    if (!schedule.ready) return;
    setBusy(true);
    try {
      let scheduledStartIso: string;
      let scheduledEndIso: string | null;
      if (job.schedule_daily) {
        const moved = moveSchedule(job, dateKey);
        if (!moved) return;
        ({ scheduled_start: scheduledStartIso, scheduled_end: scheduledEndIso } = moved);
      } else {
        ({ scheduledStartIso, scheduledEndIso } = computeRescheduleWithTime(
          job.scheduled_start,
          job.scheduled_end,
          dateKey,
          time?.hour ?? 0,
          time?.minute ?? 0
        ));
      }
      // A block moved to a different time of day is no longer the standard
      // "All day" shift; a daily job keeps its hours, so keeps the flag.
      const keptTime = toBusinessInputValue(scheduledStartIso).slice(11) === toBusinessInputValue(job.scheduled_start).slice(11);
      const allDay = !!job.schedule_all_day && keptTime;
      await schedule.reschedule(job.id, scheduledStartIso, scheduledEndIso, allDay === !!job.schedule_all_day ? {} : { scheduleAllDay: allDay });
      // Optimistic: update + re-sort by start so it lands in the right day sections.
      setJobs((cur) =>
        cur
          .map((j) =>
            j.id === job.id ? { ...j, scheduled_start: scheduledStartIso, scheduled_end: scheduledEndIso, schedule_all_day: allDay } : j
          )
          .sort((a, b) => a.scheduled_start.localeCompare(b.scheduled_start))
      );
    } catch (e) {
      Alert.alert("Couldn't reschedule", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }

  // iOS's inline "datetime" mode picks date+time in one control and applies
  // immediately, same as the original date-only picker did -- stays open for
  // continuous scrolling. Android has no combined mode, so the date dialog
  // chains into a second time dialog before anything is applied. A daily job
  // (0071) only picks its new start DATE — its hours and day count move with it.
  function onDatePicked(event: DateTimePickerEvent, selected?: Date) {
    const job = datePickerFor;
    if (Platform.OS === "ios") {
      if (event.type === "set" && selected && job) {
        void applyReschedule(
          job,
          localDateKey(selected),
          job.schedule_daily ? null : { hour: selected.getHours(), minute: selected.getMinutes() }
        );
      }
      return;
    }
    setDatePickerFor(null); // Android dialog closes itself
    if (event.type !== "set" || !selected || !job) return;
    if (job.schedule_daily) {
      void applyReschedule(job, localDateKey(selected), null);
      return;
    }
    setPendingDate(selected);
    setTimePickerFor(job);
  }

  function onTimePicked(event: DateTimePickerEvent, selected?: Date) {
    const job = timePickerFor;
    const date = pendingDate;
    setTimePickerFor(null);
    setPendingDate(null);
    if (event.type !== "set" || !selected || !job || !date) return;
    void applyReschedule(job, localDateKey(date), { hour: selected.getHours(), minute: selected.getMinutes() });
  }

  // Checked BEFORE the list, so a failed read can never render as "Nothing
  // scheduled." — the two look the same and mean opposite things.
  if (error) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ScreenError error={error} onRetry={() => { void load(); }} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.h1}>Schedule</Text>
        <Text style={styles.sub}>Tap a job to reassign, reschedule or open it</Text>
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(r) => `${r.job.id}:${r.day.dateKey}`}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.blue600} />}
        stickySectionHeadersEnabled={false}
        ListEmptyComponent={<Text style={styles.empty}>Nothing scheduled.</Text>}
        renderSectionHeader={({ section }) => <Text style={styles.dayHead}>{section.title}</Text>}
        renderItem={({ item: { job, day, index, count } }) => (
          <View style={styles.card}>
            <JobListRow
              jobNumber={job.job_number}
              title={job.title}
              subtitle={`${job.customers?.name ?? "—"}${job.profiles?.full_name ? ` · ${job.profiles.full_name}` : " · Unassigned"}${count > 1 ? ` · Day ${index + 1} of ${count}` : ""}`}
              status={job.status}
              leading={
                <View style={styles.timeCol}>
                  <Text style={styles.timeStart}>{formatBusinessTime(day.startIso)}</Text>
                  {job.scheduled_end ? <Text style={styles.timeEnd}>{formatBusinessTime(day.endIso)}</Text> : null}
                </View>
              }
              onPress={() => setMenuJob(job)}
            />
          </View>
        )}
      />

      {/* Action menu */}
      <Modal visible={!!menuJob} transparent animationType="fade" onRequestClose={() => setMenuJob(null)}>
        <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={() => setMenuJob(null)}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle} numberOfLines={1}>#{menuJob?.job_number} — {menuJob?.title}</Text>
            <Text style={styles.sheetSub}>
              {menuJob?.profiles?.full_name ?? "Unassigned"}
              {menuJob
                ? ` · ${menuJob.schedule_daily ? (formatScheduleSummary(menuJob) ?? "") : formatBusinessTime(menuJob.scheduled_start)}`
                : ""}
            </Text>
            <Action icon="person-outline" label="Reassign technician" onPress={() => { if (menuJob) openReassign(menuJob); setMenuJob(null); }} />
            <Action icon="calendar-outline" label="Reschedule" onPress={() => { setDatePickerFor(menuJob); setMenuJob(null); }} />
            <Action icon="open-outline" label="Open job details" onPress={() => { const id = menuJob?.id; setMenuJob(null); if (id) router.push(`/job/${id}`); }} />
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Technician picker */}
      <Modal visible={!!reassignJob} transparent animationType="slide" onRequestClose={() => !busy && setReassignJob(null)}>
        <View style={styles.overlay}>
          <View style={styles.pickerSheet}>
            <View style={styles.pickerHead}>
              <Text style={styles.sheetTitle}>Assign to</Text>
              {busy ? <ActivityIndicator color={colors.blue600} /> : null}
            </View>
            {staffError ? (
              <TouchableOpacity style={styles.staffErrorRow} onPress={loadStaff}>
                <Ionicons name="alert-circle-outline" size={18} color={colors.orange700} />
                <Text style={styles.staffErrorText}>Couldn&apos;t load the technician list. Tap to retry.</Text>
              </TouchableOpacity>
            ) : null}
            {reassignAssigneeCount !== null && reassignAssigneeCount > 1 ? (
              <View style={styles.staffErrorRow}>
                <Ionicons name="warning-outline" size={18} color={colors.orange700} />
                <Text style={styles.staffErrorText}>
                  This job has {reassignAssigneeCount} technicians assigned. Picking one here replaces the whole
                  crew with just them — manage multiple technicians from the web app instead.
                </Text>
              </View>
            ) : null}
            <ScrollView style={{ maxHeight: 360 }}>
              <TouchableOpacity style={styles.staffRow} onPress={() => onReassign(null)} disabled={busy}>
                <Ionicons name="close-circle-outline" size={18} color={colors.slate500} />
                <Text style={styles.staffName}>Unassign</Text>
                {!reassignJob?.assigned_to && <Ionicons name="checkmark" size={18} color={colors.blue600} />}
              </TouchableOpacity>
              {staff.map((s) => (
                <TouchableOpacity key={s.id} style={styles.staffRow} onPress={() => onReassign(s.id)} disabled={busy}>
                  <Ionicons name="person-circle-outline" size={18} color={colors.slate500} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.staffName}>{s.full_name}</Text>
                    <Text style={styles.staffRole}>{s.role}</Text>
                  </View>
                  {reassignJob?.assigned_to === s.id && <Ionicons name="checkmark" size={18} color={colors.blue600} />}
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={styles.cancelBtn} onPress={() => setReassignJob(null)} disabled={busy}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {datePickerFor && (
        <DateTimePicker
          value={new Date(datePickerFor.scheduled_start)}
          mode={Platform.OS === "ios" && !datePickerFor.schedule_daily ? "datetime" : "date"}
          onChange={onDatePicked}
        />
      )}
      {timePickerFor && (
        <DateTimePicker value={pendingDate ?? new Date(timePickerFor.scheduled_start)} mode="time" onChange={onTimePicked} />
      )}
    </SafeAreaView>
  );
}

function Action({ icon, label, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.action} onPress={onPress}>
      <Ionicons name={icon} size={19} color={colors.slate700} />
      <Text style={styles.actionText}>{label}</Text>
      <Ionicons name="chevron-forward" size={16} color={colors.slate400} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6 },
  h1: { fontSize: 22, fontWeight: "800", color: colors.slate900 },
  sub: { fontSize: 13, color: colors.slate500, marginTop: 2 },
  dayHead: { fontSize: 13, fontWeight: "700", color: colors.slate500, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4, textTransform: "uppercase" },
  card: { backgroundColor: colors.card, marginHorizontal: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 12, overflow: "hidden", marginTop: 6 },
  empty: { textAlign: "center", color: colors.slate400, marginTop: 40, fontSize: 13 },
  timeCol: { width: 52, alignItems: "center" },
  timeStart: { fontSize: 12, fontWeight: "700", color: colors.blue600 },
  timeEnd: { fontSize: 11, color: colors.slate400 },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, paddingBottom: 28, gap: 4 },
  sheetTitle: { fontSize: 16, fontWeight: "800", color: colors.slate900 },
  sheetSub: { fontSize: 13, color: colors.slate500, marginBottom: 8 },
  action: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 14, borderTopWidth: 1, borderTopColor: colors.border },
  actionText: { flex: 1, fontSize: 15, fontWeight: "600", color: colors.slate900 },
  pickerSheet: { backgroundColor: colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, paddingBottom: 28 },
  pickerHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  staffRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.border },
  staffErrorRow: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.orange100, borderRadius: 10, padding: 10 },
  staffErrorText: { flex: 1, fontSize: 12, color: colors.orange700, lineHeight: 16 },
  staffName: { fontSize: 15, fontWeight: "600", color: colors.slate900 },
  staffRole: { fontSize: 12, color: colors.slate400, textTransform: "capitalize", marginTop: 1 },
  cancelBtn: { marginTop: 12, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.bg, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  cancelText: { fontSize: 14, fontWeight: "600", color: colors.slate700 },
});
