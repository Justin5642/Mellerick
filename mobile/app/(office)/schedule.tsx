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
import { businessDayLabel, formatBusinessTime, computeRescheduleWithTime, dateKeyInBusinessTZ, localDateKey, toBusinessInputValue } from "../../lib/date";
import { businessTodayKey } from "../../lib/scheduleDisplay";
import { moveSchedule, scheduleDays, type ScheduleDay } from "../../lib/scheduling";
import { formatScheduleSummary } from "../../lib/scheduleDisplay";
import { useSchedule } from "../../lib/data/hooks/useSchedule";
import { listAssignableStaff, type AssignableStaff } from "../../lib/data/reads/schedule";
import { unwrapRows } from "../../lib/data/reads/unwrap";
import { listOpenJobBookingsRemote, type JobBooking } from "../../lib/data/reads/bookings";
import { bookingWindow } from "../../lib/bookings";

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

/**
 * What a row schedules: one booking (migration 0079), or the whole job where there are no bookings (before 0079, or a job
 * the bookings read could not cover).
 */
interface SchedItem {
  job: SchedJob;
  booking: JobBooking | null;
  /** The booking's window, or the job's. */
  window: { scheduled_start: string; scheduled_end: string | null; schedule_daily: boolean; schedule_all_day: boolean };
  /** "Dave", "Unassigned", or the job's primary assignee for a job-level row. */
  who: string | null;
}

/** One list row: an item on one of its booked days. */
interface SchedRow {
  item: SchedItem;
  day: ScheduleDay;
  index: number;
  count: number;
}

/** One item per booking; a job with no bookings stays one job-level item. */
function scheduleItems(jobs: SchedJob[], bookings: JobBooking[] | null): SchedItem[] {
  const byJob = new Map<string, JobBooking[]>();
  for (const b of bookings ?? []) {
    const list = byJob.get(b.job_id);
    if (list) list.push(b);
    else byJob.set(b.job_id, [b]);
  }
  return jobs.flatMap((job): SchedItem[] => {
    const list = byJob.get(job.id);
    if (!list || list.length === 0) {
      return [
        {
          job,
          booking: null,
          window: {
            scheduled_start: job.scheduled_start,
            scheduled_end: job.scheduled_end,
            schedule_daily: !!job.schedule_daily,
            schedule_all_day: !!job.schedule_all_day,
          },
          who: job.profiles?.full_name ?? null,
        },
      ];
    }
    return list.map((b) => ({ job, booking: b, window: bookingWindow(b), who: b.staff_name ?? (b.staff_id ? null : "Unassigned") }));
  });
}

export default function ScheduleScreen() {
  const router = useRouter();
  const schedule = useSchedule();
  const [jobs, setJobs] = useState<SchedJob[]>([]);
  // NULL before 0079 is applied: one row per job.
  const [bookings, setBookings] = useState<JobBooking[] | null>(null);
  const [staff, setStaff] = useState<AssignableStaff[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [menuItem, setMenuItem] = useState<SchedItem | null>(null);
  const [reassignJob, setReassignJob] = useState<SchedJob | null>(null);
  const [datePickerFor, setDatePickerFor] = useState<SchedItem | null>(null);
  const [timePickerFor, setTimePickerFor] = useState<SchedItem | null>(null);
  const [pendingDate, setPendingDate] = useState<Date | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [staffError, setStaffError] = useState<unknown>(null);
  // The crew being edited in the technician picker (ids), seeded from the
  // job's current job_assignments when the sheet opens.
  const [crew, setCrew] = useState<string[]>([]);

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
      return;
    }
    // Bookings split each job into its people's rows. A failure keeps the
    // job-level rows rather than taking the schedule down.
    try {
      setBookings(await listOpenJobBookingsRemote());
    } catch (e) {
      console.warn("[schedule] bookings unavailable; listing jobs:", e);
      setBookings(null);
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
  const items = useMemo(() => scheduleItems(jobs, bookings), [jobs, bookings]);

  // ... and, with bookings, one row per booked day of each BOOKING: Dave on
  // Mon–Tue and Sam on Monday morning are separate rows with their own times.
  //
  // Today and what's ahead come first, soonest at the top, so the next job is
  // the first thing on screen. Rows whose time has already ENDED (open jobs
  // left on a past date) used to lead the list, oldest first, and pushed the
  // next job to the bottom (Justin, 19 Oct 2026); they now sit in one
  // "Earlier — not finished" section at the end, most recent first.
  const sections = useMemo(() => {
    const todayKey = businessTodayKey();
    const rows = items
      .flatMap((item) => scheduleDays(item.window).map((day, index, all) => ({ item, day, index, count: all.length })))
      .sort((a, b) => a.day.startIso.localeCompare(b.day.startIso));
    const isPast = (r: SchedRow) => dateKeyInBusinessTZ(r.day.endIso) < todayKey;
    const map = new Map<string, SchedRow[]>();
    for (const r of rows.filter((r) => !isPast(r))) {
      const arr = map.get(r.day.dateKey);
      if (arr) arr.push(r);
      else map.set(r.day.dateKey, [r]);
    }
    const ahead = Array.from(map, ([, data]) => ({ title: businessDayLabel(data[0].day.startIso), data, earlier: false }));
    const earlier = rows.filter(isPast).reverse();
    return earlier.length > 0
      ? [...ahead, { title: `Earlier — not finished (${earlier.length})`, data: earlier, earlier: true }]
      : ahead;
  }, [items]);

  // Jobs are often done in pairs or more (job_assignments, migration 0059).
  // The sheet opens with the job's current crew ticked; tapping toggles a
  // technician, and Save replaces the crew in one write. It used to pick ONE
  // person through assigned_to, which collapsed any existing crew to them.
  function openReassign(job: SchedJob) {
    setReassignJob(job);
    setCrew(job.assigned_to ? [job.assigned_to] : []);
    supabase
      .from("job_assignments")
      .select("staff_id")
      .eq("job_id", job.id)
      .then(({ data, error: crewError }) => {
        // Offline / failed read: keep the primary-assignee seed above.
        if (!crewError && data) setCrew(data.map((r: { staff_id: string }) => r.staff_id));
      });
  }

  function toggleCrew(staffId: string) {
    setCrew((cur) => (cur.includes(staffId) ? cur.filter((id) => id !== staffId) : [...cur, staffId]));
  }

  async function onSaveCrew() {
    const job = reassignJob;
    if (!job || busy || !schedule.ready) return;
    setBusy(true);
    try {
      const { synced } = await schedule.setCrew(job.id, crew);
      // With bookings (0079 yet), the database turns a
      // crew change into booking changes (a removed person's bookings go; an
      // added one gets the shared window if there is one). Re-read once it
      // has landed so the rows show what it decided.
      if (synced && bookings) void load();
      // Optimistic: reflect the change immediately (the outbox syncs in the
      // background — offline, a server reload would show stale data).
      const names = crew.map((id) => staff.find((s) => s.id === id)?.full_name).filter(Boolean).join(", ");
      setJobs((cur) =>
        cur.map((j) => (j.id === job.id ? { ...j, assigned_to: crew[0] ?? null, profiles: crew.length ? { full_name: names } : null } : j))
      );
      setReassignJob(null);
    } catch (e) {
      Alert.alert("Couldn't save the crew", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }

  // `time` is null for a daily job: it moves to start on `dateKey` keeping its
  // daily hours and its NUMBER OF BOOKED DAYS (moveSchedule — a Mon–Wed job
  // moved to Thursday becomes Thu, Fri, Mon). A continuous block takes the
  // picked date and time and keeps its duration, as before.
  async function applyReschedule(item: SchedItem, dateKey: string, time: { hour: number; minute: number } | null) {
    if (!schedule.ready) return;
    const { job, booking, window } = item;
    setBusy(true);
    try {
      let scheduledStartIso: string;
      let scheduledEndIso: string | null;
      if (window.schedule_daily) {
        const moved = moveSchedule(window, dateKey);
        if (!moved) return;
        ({ scheduled_start: scheduledStartIso, scheduled_end: scheduledEndIso } = moved);
      } else {
        ({ scheduledStartIso, scheduledEndIso } = computeRescheduleWithTime(
          window.scheduled_start,
          window.scheduled_end,
          dateKey,
          time?.hour ?? 0,
          time?.minute ?? 0
        ));
      }
      // A block moved to a different time of day is no longer the standard
      // "All day" shift; a daily job keeps its hours, so keeps the flag.
      const keptTime = toBusinessInputValue(scheduledStartIso).slice(11) === toBusinessInputValue(window.scheduled_start).slice(11);
      const allDay = window.schedule_all_day && keptTime;
      if (booking) {
        // Only this person's booking moves; the database re-derives the
        // job's overall window from all of them.
        await schedule.updateBooking(job.id, booking.id, {
          columns: { scheduled_start: scheduledStartIso, scheduled_end: scheduledEndIso, schedule_daily: window.schedule_daily, schedule_all_day: allDay },
        });
        setBookings((cur) =>
          (cur ?? []).map((b) =>
            b.id === booking.id ? { ...b, starts_at: scheduledStartIso, ends_at: scheduledEndIso, all_day: allDay } : b
          )
        );
        return;
      }
      await schedule.reschedule(job.id, scheduledStartIso, scheduledEndIso, allDay === window.schedule_all_day ? {} : { scheduleAllDay: allDay });
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
    const item = datePickerFor;
    if (Platform.OS === "ios") {
      if (event.type === "set" && selected && item) {
        void applyReschedule(
          item,
          localDateKey(selected),
          item.window.schedule_daily ? null : { hour: selected.getHours(), minute: selected.getMinutes() }
        );
      }
      return;
    }
    setDatePickerFor(null); // Android dialog closes itself
    if (event.type !== "set" || !selected || !item) return;
    if (item.window.schedule_daily) {
      void applyReschedule(item, localDateKey(selected), null);
      return;
    }
    setPendingDate(selected);
    setTimePickerFor(item);
  }

  function onTimePicked(event: DateTimePickerEvent, selected?: Date) {
    const item = timePickerFor;
    const date = pendingDate;
    setTimePickerFor(null);
    setPendingDate(null);
    if (event.type !== "set" || !selected || !item || !date) return;
    void applyReschedule(item, localDateKey(date), { hour: selected.getHours(), minute: selected.getMinutes() });
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
        keyExtractor={(r) => `${r.item.job.id}:${r.item.booking?.id ?? "job"}:${r.day.dateKey}`}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.blue600} />}
        stickySectionHeadersEnabled={false}
        ListEmptyComponent={<Text style={styles.empty}>Nothing scheduled.</Text>}
        renderSectionHeader={({ section }) => <Text style={styles.dayHead}>{section.title}</Text>}
        renderItem={({ item: { item, day, index, count }, section }) => (
          <View style={styles.card}>
            <JobListRow
              jobNumber={item.job.job_number}
              title={item.job.title}
              // Rows under "Earlier" have no day heading above them, so they
              // carry their own date.
              subtitle={`${section.earlier ? `${businessDayLabel(day.startIso)} · ` : ""}${item.job.customers?.name ?? "—"} · ${item.who ?? "Unassigned"}${count > 1 ? ` · Day ${index + 1} of ${count}` : ""}`}
              status={item.job.status}
              leading={
                <View style={styles.timeCol}>
                  <Text style={styles.timeStart}>{formatBusinessTime(day.startIso)}</Text>
                  {item.window.scheduled_end ? <Text style={styles.timeEnd}>{formatBusinessTime(day.endIso)}</Text> : null}
                </View>
              }
              onPress={() => setMenuItem(item)}
            />
          </View>
        )}
      />

      {/* Action menu */}
      <Modal visible={!!menuItem} transparent animationType="fade" onRequestClose={() => setMenuItem(null)}>
        <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={() => setMenuItem(null)}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle} numberOfLines={1}>#{menuItem?.job.job_number} — {menuItem?.job.title}</Text>
            <Text style={styles.sheetSub}>
              {menuItem?.who ?? "Unassigned"}
              {menuItem
                ? ` · ${menuItem.window.schedule_daily ? (formatScheduleSummary(menuItem.window) ?? "") : formatBusinessTime(menuItem.window.scheduled_start)}`
                : ""}
            </Text>
            <Action icon="person-outline" label="Reassign technician" onPress={() => { if (menuItem) openReassign(menuItem.job); setMenuItem(null); }} />
            <Action
              icon="calendar-outline"
              label={menuItem?.booking ? "Reschedule this booking" : "Reschedule"}
              onPress={() => { setDatePickerFor(menuItem); setMenuItem(null); }}
            />
            <Action icon="open-outline" label="Open job details" onPress={() => { const id = menuItem?.job.id; setMenuItem(null); if (id) router.push(`/job/${id}`); }} />
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Technician picker */}
      <Modal visible={!!reassignJob} transparent animationType="slide" onRequestClose={() => !busy && setReassignJob(null)}>
        <View style={styles.overlay}>
          <View style={styles.pickerSheet}>
            <View style={styles.pickerHead}>
              <Text style={styles.sheetTitle}>Crew</Text>
              {busy ? <ActivityIndicator color={colors.blue600} /> : null}
            </View>
            {staffError ? (
              <TouchableOpacity style={styles.staffErrorRow} onPress={loadStaff}>
                <Ionicons name="alert-circle-outline" size={18} color={colors.orange700} />
                <Text style={styles.staffErrorText}>Couldn&apos;t load the technician list. Tap to retry.</Text>
              </TouchableOpacity>
            ) : null}
            <Text style={styles.staffRole}>Tap everyone working on this job, then Save.</Text>
            <ScrollView style={{ maxHeight: 360 }}>
              {staff.map((s) => {
                const on = crew.includes(s.id);
                return (
                  <TouchableOpacity
                    key={s.id}
                    style={styles.staffRow}
                    onPress={() => toggleCrew(s.id)}
                    disabled={busy}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on }}
                  >
                    <Ionicons name={on ? "checkbox" : "square-outline"} size={20} color={on ? colors.blue600 : colors.slate400} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.staffName}>{s.full_name}</Text>
                      <Text style={styles.staffRole}>{s.role}</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
            <TouchableOpacity style={styles.saveCrewBtn} onPress={onSaveCrew} disabled={busy}>
              <Text style={styles.saveCrewText}>
                {crew.length === 0 ? "Save — unassigned" : `Save — ${crew.length} technician${crew.length === 1 ? "" : "s"}`}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.cancelBtn} onPress={() => setReassignJob(null)} disabled={busy}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {datePickerFor && (
        <DateTimePicker
          value={new Date(datePickerFor.window.scheduled_start)}
          mode={Platform.OS === "ios" && !datePickerFor.window.schedule_daily ? "datetime" : "date"}
          onChange={onDatePicked}
        />
      )}
      {timePickerFor && (
        <DateTimePicker value={pendingDate ?? new Date(timePickerFor.window.scheduled_start)} mode="time" onChange={onTimePicked} />
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
  saveCrewBtn: { marginTop: 12, paddingVertical: 12, borderRadius: 10, alignItems: "center", backgroundColor: colors.blue600 },
  saveCrewText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  cancelBtn: { marginTop: 12, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.bg, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  cancelText: { fontSize: 14, fontWeight: "600", color: colors.slate700 },
});
