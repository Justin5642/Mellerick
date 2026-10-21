import { useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Modal, Alert, Platform, TextInput } from "react-native";
import DateTimePicker, { type DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { listAssignableStaff, countOtherScheduledJobs, type AssignableStaff } from "../../lib/data/reads/schedule";
import { useSchedule } from "../../lib/data/hooks/useSchedule";
import { useJobNotes } from "../../lib/data/hooks/useJobNotes";
import {
  DEFAULT_SHIFT_START_TIME,
  DEFAULT_SHIFT_END_TIME,
  buildScheduleColumns,
  defaultAllDay,
  scheduleInputFromJob,
  validateScheduleInput,
  type ScheduleInput,
} from "../../lib/scheduling";
import { businessTodayKey, formatScheduleSummary, shortDayLabel } from "../../lib/scheduleDisplay";
import { localDateKey } from "../../lib/date";
import type { JobCostCentre } from "../../lib/data/reads/jobBilling";
import type { JobBooking } from "../../lib/data/reads/bookings";
import { bookingColumns, bookingWindow } from "../../lib/bookings";

interface Props {
  visible: boolean;
  onClose: () => void;
  jobId: string;
  jobStatus: string;
  currentAssignedIds: string[];
  currentUserId: string;
  currentScheduledStart: string | null;
  currentScheduledEnd: string | null;
  /** jobs.schedule_daily / schedule_all_day (migration 0071) — so the dialog reopens as saved. */
  currentScheduleDaily?: boolean;
  currentScheduleAllDay?: boolean;
  costCenters?: JobCostCentre[];
  currentScheduledCostCenterId?: string | null;
  /**
   * The job's bookings (migration 0079 yet). NULL
   * means bookings do not exist yet: the dialog is then the single-schedule
   * form it always was, writing the job-level schedule. An array (even
   * empty) turns it into the bookings list editor.
   */
  bookings?: JobBooking[] | null;
  /** The list after an add / edit / delete — the screen shows it at once, offline included. */
  onBookingsChanged?: (next: JobBooking[]) => void;
  onScheduled: (patch: {
    scheduled_start: string;
    scheduled_end: string;
    schedule_daily: boolean;
    schedule_all_day: boolean;
    status: string;
    scheduled_cost_center_id: string | null;
  }) => void;
}

/** A Melbourne "YYYY-MM-DD" as a device-local Date for the picker (noon: no DST edge). */
function keyToPickerDate(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d, 12, 0, 0, 0);
}

type Step = "technician" | "time" | "stage" | "notes" | "confirm";

/** The bookings editor shows the list, or the add / edit form over it. */
type Mode = { kind: "list" } | { kind: "add" } | { kind: "edit"; booking: JobBooking } | { kind: "legacy" };

function friendlyTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const period = h < 12 ? "am" : "pm";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")}${period}`;
}

/**
 * BOOKINGS (0079 yet): once a job has bookings, this is
 * a bookings list editor like the website's — each row one person's window
 * and cost centre, with Add (technician(s), window, cost centre — one booking
 * per technician), Edit and Delete. Each change is a job_bookings insert /
 * update / delete through the outbox (ScheduleRepository.addBookings etc.),
 * so it works offline; the database derives the job's schedule and crew.
 * Before 0079 is applied (`bookings` null) it is exactly the dialog below.
 *
 * Mobile twin of the web job detail's "Schedule Job" dialog — multi-select
 * technician, start + end date (same daily hours on each booked weekday —
 * migration 0071) with an All day toggle, optional cost centre, an optional
 * note for the technician, then confirm — same shared rules (lib/scheduling.ts),
 * writing through ScheduleRepository.schedule() so the job/time update is one
 * durable outbox entry with a coalesced calendar sync and a coalesced
 * assign-technicians side effect (which proxies set_job_assignments through
 * the web API, since the outbox has no native RPC path).
 */
export function ScheduleJobModal({
  visible,
  onClose,
  jobId,
  jobStatus,
  currentAssignedIds,
  currentUserId,
  currentScheduledStart,
  currentScheduledEnd,
  currentScheduleDaily = false,
  currentScheduleAllDay = false,
  costCenters = [],
  currentScheduledCostCenterId,
  bookings = null,
  onBookingsChanged,
  onScheduled,
}: Props) {
  const { schedule, addBookings, updateBooking, deleteBooking, ready } = useSchedule();
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const { addNote } = useJobNotes();
  const [step, setStep] = useState<Step>("technician");
  const [staff, setStaff] = useState<AssignableStaff[]>([]);
  const [technicianIds, setTechnicianIds] = useState<string[]>(currentAssignedIds);
  const [costCenterId, setCostCenterId] = useState<string | null>(currentScheduledCostCenterId ?? null);
  // Melbourne "YYYY-MM-DD" keys — the picker's local date converts straight to
  // one (localDateKey), so a phone in another timezone books the day it shows.
  const [startDateKey, setStartDateKey] = useState(() => businessTodayKey());
  const [endDateKey, setEndDateKey] = useState(() => businessTodayKey());
  const [showDatePicker, setShowDatePicker] = useState<"start" | "end" | null>(null);
  // The start day of the schedule being edited (null for a new one): the
  // "All day" smart default only overrides what was SAVED once the office
  // moves the job to a different day.
  const [savedStartKey, setSavedStartKey] = useState<string | null>(null);
  const [allDay, setAllDay] = useState(true);
  const [startTime, setStartTime] = useState(DEFAULT_SHIFT_START_TIME);
  const [endTime, setEndTime] = useState(DEFAULT_SHIFT_END_TIME);
  const [showTimePicker, setShowTimePicker] = useState<"start" | "end" | null>(null);
  const [conflictsByTechnician, setConflictsByTechnician] = useState<Record<string, number>>({});
  const [noteText, setNoteText] = useState("");
  const [saving, setSaving] = useState(false);

  // Load the form: a new booking (blank: nobody, today), an existing one, or
  // the job's single schedule (before bookings exist).
  function openForm(next: Mode) {
    setMode(next);
    setStep("technician");
    const editing = next.kind === "edit" ? next.booking : null;
    if (next.kind === "legacy") {
      setTechnicianIds(currentAssignedIds);
      setCostCenterId(currentScheduledCostCenterId ?? null);
      loadWindow(currentScheduledStart, currentScheduledEnd, currentScheduleDaily, currentScheduleAllDay);
    } else if (editing) {
      setTechnicianIds(editing.staff_id ? [editing.staff_id] : []);
      setCostCenterId(editing.cost_center_id);
      loadWindow(editing.starts_at, editing.ends_at, editing.daily, editing.all_day);
    } else {
      setTechnicianIds([]);
      setCostCenterId(null);
      loadWindow(null, null, false, false);
    }
    setShowDatePicker(null);
    setConflictsByTechnician({});
    setNoteText("");
  }

  useEffect(() => {
    if (!visible) return;
    listAssignableStaff().then(setStaff).catch(() => {});
    if (bookings === null) openForm({ kind: "legacy" });
    else setMode({ kind: "list" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, bookings === null, currentScheduledStart, currentScheduledEnd, currentScheduleDaily, currentScheduleAllDay, currentScheduledCostCenterId]);

  function loadWindow(start: string | null, end: string | null, daily: boolean, allDayFlag: boolean) {
    // Reopen as saved (start/end date, hours, All day) — the reverse of
    // buildScheduleColumns. A saved start with no end is a point in time;
    // it reopens on its day with the standard shift.
    const saved =
      start && end
        ? scheduleInputFromJob({
            scheduled_start: start,
            scheduled_end: end,
            schedule_daily: daily,
            schedule_all_day: allDayFlag,
          })
        : null;
    if (saved) {
      setStartDateKey(saved.startDateKey);
      setEndDateKey(saved.endDateKey);
      setAllDay(saved.allDay);
      setStartTime(saved.allDay ? DEFAULT_SHIFT_START_TIME : saved.startTime);
      setEndTime(saved.allDay ? DEFAULT_SHIFT_END_TIME : saved.endTime);
      setSavedStartKey(saved.startDateKey);
    } else {
      const key = start
        ? (scheduleInputFromJob({ scheduled_start: start, scheduled_end: null })?.startDateKey ?? businessTodayKey())
        : businessTodayKey();
      setStartDateKey(key);
      setEndDateKey(key);
      setAllDay(true);
      setStartTime(DEFAULT_SHIFT_START_TIME);
      setEndTime(DEFAULT_SHIFT_END_TIME);
      setSavedStartKey(null);
    }
  }

  // The "All day" default and the conflict warning look at the START day.
  const dateKey = startDateKey;

  function toggleTechnician(id: string) {
    // One booking is one person: editing picks a single technician (or none).
    if (mode.kind === "edit") {
      setTechnicianIds((prev) => (prev.includes(id) ? [] : [id]));
      return;
    }
    setTechnicianIds((prev) => (prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]));
  }

  // Smart default, same rule as the web dialog: zero other jobs that day for
  // any selected technician -> All day stays on; one or more for any of them
  // -> default off for a custom block. Reuses the existing single-technician
  // read (unchanged, still PowerSync-backed) once per selected id rather than
  // widening that read's contract to accept an array.
  useEffect(() => {
    if (!visible || step !== "time" || technicianIds.length === 0) return;
    let cancelled = false;
    Promise.all(technicianIds.map((id) => countOtherScheduledJobs(id, dateKey, jobId).then((n) => [id, n] as const)))
      .then((pairs) => {
        if (cancelled) return;
        const counts = Object.fromEntries(pairs.filter(([, n]) => n > 0));
        setConflictsByTechnician(counts);
        // Editing a saved schedule on its own start day: keep its saved "All
        // day" choice (0071, persists it) rather than re-guessing it.
        if (dateKey === savedStartKey) return;
        const maxConflicts = Math.max(0, ...Object.values(counts));
        const nextAllDay = defaultAllDay(maxConflicts);
        setAllDay(nextAllDay);
        if (nextAllDay) {
          setStartTime(DEFAULT_SHIFT_START_TIME);
          setEndTime(DEFAULT_SHIFT_END_TIME);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [visible, step, technicianIds, dateKey, jobId, savedStartKey]);

  function toggleAllDay() {
    const next = !allDay;
    setAllDay(next);
    if (next) {
      setStartTime(DEFAULT_SHIFT_START_TIME);
      setEndTime(DEFAULT_SHIFT_END_TIME);
    }
  }

  function onDateChange(which: "start" | "end", event: DateTimePickerEvent, selected?: Date) {
    setShowDatePicker(Platform.OS === "ios" ? which : null);
    if (event.type !== "set" || !selected) return;
    const key = localDateKey(selected);
    if (which === "start") {
      // A start moved past the end drags the end with it (end ≥ start).
      setStartDateKey(key);
      if (endDateKey < key) setEndDateKey(key);
    } else {
      setEndDateKey(key);
    }
  }

  function onTimeChange(which: "start" | "end", event: DateTimePickerEvent, selected?: Date) {
    setShowTimePicker(Platform.OS === "ios" ? which : null);
    if (event.type !== "set" || !selected) return;
    const hhmm = `${String(selected.getHours()).padStart(2, "0")}:${String(selected.getMinutes()).padStart(2, "0")}`;
    if (which === "start") setStartTime(hhmm);
    else setEndTime(hhmm);
  }

  const selectedTechnicians = staff.filter((s) => technicianIds.includes(s.id));
  const input: ScheduleInput = { startDateKey, endDateKey, startTime, endTime, allDay };
  const windowError = validateScheduleInput(input);
  // The columns written — window + schedule_daily + schedule_all_day — from
  // the shared rules (lib/scheduling.ts), so the phone and the board agree.
  const columns = windowError ? null : buildScheduleColumns(input);
  // "Mon 19 – Wed 21 Oct, 7:00–15:30 each weekday · 3 days"
  const summary = columns ? formatScheduleSummary(columns) : null;
  const hasCostCenters = costCenters.length > 0;

  function timeAsDate(hhmm: string): Date {
    const [h, m] = hhmm.split(":").map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d;
  }

  const isBookings = mode.kind === "add" || mode.kind === "edit";
  // The single-schedule form needs a crew (as it always did); a booking may
  // be unassigned — the board's Unassigned row.
  const needsTechnician = !isBookings;
  // An edit changes one booking's who/when/stage; a note belongs with a new booking.
  const skipNotes = mode.kind === "edit";

  function staffName(id: string | null): string | null {
    return id ? (staff.find((s) => s.id === id)?.full_name ?? null) : null;
  }

  async function confirmBooking() {
    if (!columns || saving || !ready || !bookings) return;
    setSaving(true);
    try {
      if (mode.kind === "edit") {
        const b = mode.booking;
        const staffId = technicianIds[0] ?? null;
        await updateBooking(jobId, b.id, { staffId, costCenterId, columns });
        const next = bookings.map((x) =>
          x.id === b.id ? { ...x, staff_id: staffId, staff_name: staffName(staffId), cost_center_id: costCenterId, ...bookingColumns(columns) } : x
        );
        onBookingsChanged?.(next.sort((a, c) => a.starts_at.localeCompare(c.starts_at)));
      } else {
        const people = technicianIds.length > 0 ? [...new Set(technicianIds)] : [null];
        const { ids } = await addBookings(jobId, technicianIds, columns, costCenterId);
        const added: JobBooking[] = ids.map((id, i) => ({
          id,
          job_id: jobId,
          staff_id: people[i],
          staff_name: staffName(people[i]),
          cost_center_id: costCenterId,
          ...bookingColumns(columns),
        }));
        onBookingsChanged?.([...bookings, ...added].sort((a, c) => a.starts_at.localeCompare(c.starts_at)));
      }
    } catch (e) {
      setSaving(false);
      Alert.alert("Couldn't save the booking", e instanceof Error ? e.message : "Please try again.");
      return;
    }
    // Same as the single-schedule path: a note failure is reported on its
    // own, never as the booking failing.
    const trimmed = noteText.trim();
    let noteFailed = false;
    if (trimmed && mode.kind === "add") {
      try {
        await addNote({ jobId, authorId: currentUserId, content: trimmed, source: "schedule" });
      } catch {
        noteFailed = true;
      }
    }
    setSaving(false);
    setMode({ kind: "list" });
    if (noteFailed) Alert.alert("Booking saved", "The note could not be saved — add it from the Notes tab.");
  }

  function confirmDelete(b: JobBooking) {
    if (!bookings) return;
    Alert.alert(
      "Delete booking?",
      `${b.staff_name ?? "Unassigned"} · ${formatScheduleSummary(bookingWindow(b)) ?? ""}`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              await deleteBooking(jobId, b.id);
              onBookingsChanged?.(bookings.filter((x) => x.id !== b.id));
            } catch (e) {
              Alert.alert("Couldn't delete the booking", e instanceof Error ? e.message : "Please try again.");
            }
          },
        },
      ]
    );
  }

  async function confirm() {
    if (isBookings) return confirmBooking();
    if (technicianIds.length === 0 || !columns || saving || !ready) return;
    setSaving(true);
    try {
      await schedule(jobId, technicianIds, columns, costCenterId);
    } catch (e) {
      setSaving(false);
      Alert.alert("Couldn't schedule", e instanceof Error ? e.message : "Please try again.");
      return;
    }

    // The schedule itself landed — a note failure shouldn't look like the
    // whole operation failed, so it's reported separately rather than
    // routing through the same catch block above.
    let noteFailed = false;
    const trimmed = noteText.trim();
    if (trimmed) {
      try {
        await addNote({ jobId, authorId: currentUserId, content: trimmed, source: "schedule" });
      } catch {
        noteFailed = true;
      }
    }

    onScheduled({
      ...columns,
      status: jobStatus === "pending" ? "scheduled" : jobStatus,
      scheduled_cost_center_id: costCenterId,
    });
    setSaving(false);
    onClose();
    if (noteFailed) {
      Alert.alert("Job scheduled", "The note could not be saved — add it from the Notes tab.");
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={() => !saving && onClose()}>
      <View style={styles.overlay}>
        <ScrollView automaticallyAdjustKeyboardInsets keyboardDismissMode="interactive" style={styles.sheetScroll} contentContainerStyle={styles.sheet} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>
            {mode.kind === "add" ? "Add booking" : mode.kind === "edit" ? "Edit booking" : "Schedule job"}
          </Text>

          {mode.kind === "list" && bookings && (
            <View style={{ gap: 8 }}>
              {bookings.length === 0 && <Text style={styles.hint}>Not booked yet. Add who is going, when, and against which cost centre.</Text>}
              {bookings.map((b) => (
                <View key={b.id} style={styles.bookingRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowText}>{b.staff_name ?? (b.staff_id ? "Technician" : "Unassigned")}</Text>
                    <Text style={styles.bookingSub}>
                      {formatScheduleSummary(bookingWindow(b))}
                      {b.all_day ? " · All day" : ""}
                    </Text>
                    {b.cost_center_id && (
                      <Text style={styles.bookingSub}>
                        Stage: {costCenters.find((cc) => cc.id === b.cost_center_id)?.name ?? "—"}
                      </Text>
                    )}
                  </View>
                  <TouchableOpacity onPress={() => openForm({ kind: "edit", booking: b })} accessibilityLabel="Edit booking" style={styles.iconBtn}>
                    <Ionicons name="create-outline" size={19} color={colors.blue600} />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => confirmDelete(b)} accessibilityLabel="Delete booking" style={styles.iconBtn}>
                    <Ionicons name="trash-outline" size={19} color={colors.red600} />
                  </TouchableOpacity>
                </View>
              ))}
              <View style={styles.actions}>
                <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
                  <Text style={styles.cancelText}>Done</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.doneBtn} onPress={() => openForm({ kind: "add" })} disabled={!ready}>
                  <Text style={styles.doneText}>Add booking</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {mode.kind !== "list" && (
          <>
          {step === "technician" && (
            <View style={{ gap: 6 }}>
              {isBookings && (
                <Text style={styles.hint}>
                  {mode.kind === "edit"
                    ? "Who this booking is for — or nobody, to leave it unassigned."
                    : "Pick everyone going (one booking each, same time and stage) — or nobody for an unassigned booking."}
                </Text>
              )}
              {staff.length === 0 && <Text style={styles.hint}>No active staff found.</Text>}
              {staff.map((s) => {
                const active = technicianIds.includes(s.id);
                return (
                  <TouchableOpacity
                    key={s.id}
                    style={[styles.row, active && styles.rowActive]}
                    onPress={() => toggleTechnician(s.id)}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.rowText}>{s.full_name}</Text>
                      <Text style={styles.rowSub}>{s.role}</Text>
                    </View>
                    {active && <Ionicons name="checkmark" size={18} color={colors.blue600} />}
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {step === "time" && (
            <View style={{ gap: 14 }}>
              <View style={{ flexDirection: "row", gap: 10 }}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>Start date</Text>
                  <TouchableOpacity style={styles.selector} onPress={() => setShowDatePicker("start")}>
                    <Text style={styles.selectorText}>{shortDayLabel(startDateKey)}</Text>
                    <Ionicons name="calendar-outline" size={16} color={colors.slate400} />
                  </TouchableOpacity>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>End date</Text>
                  <TouchableOpacity style={styles.selector} onPress={() => setShowDatePicker("end")}>
                    <Text style={styles.selectorText}>{shortDayLabel(endDateKey)}</Text>
                    <Ionicons name="calendar-outline" size={16} color={colors.slate400} />
                  </TouchableOpacity>
                </View>
              </View>
              {showDatePicker && (
                <DateTimePicker
                  value={keyToPickerDate(showDatePicker === "start" ? startDateKey : endDateKey)}
                  minimumDate={showDatePicker === "end" ? keyToPickerDate(startDateKey) : undefined}
                  mode="date"
                  onChange={(e, d) => onDateChange(showDatePicker, e, d)}
                />
              )}
              {endDateKey > startDateKey && (
                <Text style={styles.hint}>Same hours on each weekday — Saturdays and Sundays between the dates are skipped.</Text>
              )}

              <TouchableOpacity style={styles.allDayRow} onPress={toggleAllDay}>
                <Ionicons name={allDay ? "checkbox" : "square-outline"} size={20} color={allDay ? colors.blue600 : colors.slate400} />
                <Text style={styles.allDayText}>
                  All day ({friendlyTime(DEFAULT_SHIFT_START_TIME)} – {friendlyTime(DEFAULT_SHIFT_END_TIME)})
                </Text>
              </TouchableOpacity>

              {Object.entries(conflictsByTechnician).map(([staffId, n]) => {
                const name = staff.find((s) => s.id === staffId)?.full_name ?? "This technician";
                return (
                  <Text key={staffId} style={styles.warnHint}>
                    {name} already has {n} job{n === 1 ? "" : "s"} on {shortDayLabel(startDateKey)} — set a custom time block below.
                  </Text>
                );
              })}

              {!allDay && (
                <View style={{ flexDirection: "row", gap: 10 }}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.label}>Start</Text>
                    <TouchableOpacity style={styles.selector} onPress={() => setShowTimePicker("start")}>
                      <Text style={styles.selectorText}>{friendlyTime(startTime)}</Text>
                    </TouchableOpacity>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.label}>End</Text>
                    <TouchableOpacity style={styles.selector} onPress={() => setShowTimePicker("end")}>
                      <Text style={styles.selectorText}>{friendlyTime(endTime)}</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              )}
              {!allDay && showTimePicker && (
                <DateTimePicker
                  value={timeAsDate(showTimePicker === "start" ? startTime : endTime)}
                  mode="time"
                  onChange={(e, d) => onTimeChange(showTimePicker, e, d)}
                />
              )}

              {windowError ? (
                <Text style={styles.errorText}>{windowError}</Text>
              ) : summary ? (
                <Text style={styles.summaryText}>{summary}</Text>
              ) : null}
            </View>
          )}

          {step === "stage" && (
            <View style={{ gap: 6 }}>
              <Text style={styles.label}>Cost centre (optional)</Text>
              <TouchableOpacity
                style={[styles.row, costCenterId === null && styles.rowActive]}
                onPress={() => setCostCenterId(null)}
              >
                <Text style={styles.rowText}>No stage selected</Text>
                {costCenterId === null && <Ionicons name="checkmark" size={18} color={colors.blue600} />}
              </TouchableOpacity>
              {costCenters.map((cc) => {
                const active = costCenterId === cc.id;
                return (
                  <TouchableOpacity
                    key={cc.id}
                    style={[styles.row, active && styles.rowActive]}
                    onPress={() => setCostCenterId(cc.id)}
                  >
                    <Text style={styles.rowText}>
                      {cc.name}{cc.po_number ? ` (PO #${cc.po_number})` : ""}
                    </Text>
                    {active && <Ionicons name="checkmark" size={18} color={colors.blue600} />}
                  </TouchableOpacity>
                );
              })}
              <Text style={styles.hint}>
                Time logged on this job defaults to this stage at clock-in — the technician can still change it per entry.
              </Text>
            </View>
          )}

          {step === "notes" && (
            <View style={{ gap: 6 }}>
              <Text style={styles.label}>Notes for the technician (optional)</Text>
              <TextInput
                style={[styles.input, styles.inputMultiline]}
                value={noteText}
                onChangeText={setNoteText}
                placeholder="What should they achieve on this job today?"
                placeholderTextColor={colors.slate400}
                multiline
              />
              <Text style={styles.hint}>
                Posted to this job&apos;s Notes tab, visible to everyone assigned.
              </Text>
            </View>
          )}

          {step === "confirm" && (
            <View style={styles.confirmBox}>
              <Text style={styles.confirmTech}>{selectedTechnicians.map((t) => t.full_name).join(", ") || "Unassigned"}</Text>
              <Text style={styles.confirmLine}>
                {summary}
                {allDay ? " · All day" : ""}
              </Text>
              {hasCostCenters && (
                <Text style={styles.confirmLine}>
                  Stage: {costCenters.find((cc) => cc.id === costCenterId)?.name ?? "None"}
                </Text>
              )}
              <Text style={styles.hint}>
                This sets the planned schedule block only — worked hours are still captured separately via clock-on/clock-off.
              </Text>
            </View>
          )}

          <View style={styles.actions}>
            <TouchableOpacity
              style={styles.cancelBtn}
              onPress={() =>
                step === "technician"
                  ? (isBookings ? setMode({ kind: "list" }) : onClose())
                  : setStep(
                      step === "confirm"
                        ? (skipNotes ? (hasCostCenters ? "stage" : "time") : "notes")
                        : step === "notes"
                        ? (hasCostCenters ? "stage" : "time")
                        : step === "stage"
                        ? "time"
                        : "technician"
                    )
              }
              disabled={saving}
            >
              <Text style={styles.cancelText}>{step === "technician" ? "Cancel" : "Back"}</Text>
            </TouchableOpacity>
            {step === "technician" && (
              <TouchableOpacity
                style={[styles.doneBtn, needsTechnician && technicianIds.length === 0 && styles.doneBtnDisabled]}
                onPress={() => setStep("time")}
                disabled={needsTechnician && technicianIds.length === 0}
              >
                <Text style={styles.doneText}>Next</Text>
              </TouchableOpacity>
            )}
            {step === "time" && (
              <TouchableOpacity
                style={[styles.doneBtn, !!windowError && styles.doneBtnDisabled]}
                onPress={() => setStep(hasCostCenters ? "stage" : skipNotes ? "confirm" : "notes")}
                disabled={!!windowError}
              >
                <Text style={styles.doneText}>Next</Text>
              </TouchableOpacity>
            )}
            {step === "stage" && (
              <TouchableOpacity style={styles.doneBtn} onPress={() => setStep(skipNotes ? "confirm" : "notes")}>
                <Text style={styles.doneText}>Next</Text>
              </TouchableOpacity>
            )}
            {step === "notes" && (
              <TouchableOpacity style={styles.doneBtn} onPress={() => setStep("confirm")}>
                <Text style={styles.doneText}>Next</Text>
              </TouchableOpacity>
            )}
            {step === "confirm" && (
              <TouchableOpacity style={styles.doneBtn} onPress={confirm} disabled={saving}>
                <Text style={styles.doneText}>{saving ? "Saving…" : "Confirm"}</Text>
              </TouchableOpacity>
            )}
          </View>
          </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, backgroundColor: colors.bg, color: colors.slate900 },
  inputMultiline: { minHeight: 90, textAlignVertical: "top" },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheetScroll: { maxHeight: "88%", flexGrow: 0 },
  sheet: { backgroundColor: colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, paddingBottom: 28 },
  title: { fontSize: 16, fontWeight: "800", color: colors.slate900, marginBottom: 12 },
  hint: { fontSize: 12, color: colors.slate400, marginTop: 4 },
  warnHint: { fontSize: 12, color: colors.yellow700 },
  errorText: { fontSize: 12, color: colors.red600 },
  summaryText: { fontSize: 13, fontWeight: "600", color: colors.slate700 },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  rowActive: { borderColor: colors.blue600, backgroundColor: colors.blue100 },
  rowText: { fontSize: 14, fontWeight: "600", color: colors.slate900 },
  rowSub: { fontSize: 11, color: colors.slate400, textTransform: "capitalize", marginTop: 1 },
  label: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginBottom: 6 },
  selector: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12, backgroundColor: colors.bg },
  selectorText: { fontSize: 14, color: colors.slate900, fontWeight: "500" },
  allDayRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  allDayText: { fontSize: 14, fontWeight: "600", color: colors.slate700 },
  confirmBox: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 14, gap: 4 },
  confirmTech: { fontSize: 15, fontWeight: "700", color: colors.slate900 },
  confirmLine: { fontSize: 13, color: colors.slate500 },
  actions: { flexDirection: "row", gap: 10, marginTop: 18 },
  cancelBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.bg, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  cancelText: { color: colors.slate700, fontWeight: "600", fontSize: 14 },
  doneBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.blue600, alignItems: "center" },
  doneBtnDisabled: { opacity: 0.5 },
  doneText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  bookingRow: { flexDirection: "row", alignItems: "center", gap: 4, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  bookingSub: { fontSize: 12, color: colors.slate500, marginTop: 2 },
  iconBtn: { padding: 8 },
});
