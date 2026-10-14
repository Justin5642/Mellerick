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

function friendlyTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const period = h < 12 ? "am" : "pm";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")}${period}`;
}

/**
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
  onScheduled,
}: Props) {
  const { schedule, ready } = useSchedule();
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

  useEffect(() => {
    if (!visible) return;
    listAssignableStaff().then(setStaff).catch(() => {});
    setStep("technician");
    setTechnicianIds(currentAssignedIds);
    setCostCenterId(currentScheduledCostCenterId ?? null);
    // Reopen as saved (start/end date, hours, All day) — the reverse of
    // buildScheduleColumns. A saved start with no end is a point in time;
    // it reopens on its day with the standard shift.
    const saved =
      currentScheduledStart && currentScheduledEnd
        ? scheduleInputFromJob({
            scheduled_start: currentScheduledStart,
            scheduled_end: currentScheduledEnd,
            schedule_daily: currentScheduleDaily,
            schedule_all_day: currentScheduleAllDay,
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
      const key = currentScheduledStart
        ? (scheduleInputFromJob({ scheduled_start: currentScheduledStart, scheduled_end: null })?.startDateKey ?? businessTodayKey())
        : businessTodayKey();
      setStartDateKey(key);
      setEndDateKey(key);
      setAllDay(true);
      setStartTime(DEFAULT_SHIFT_START_TIME);
      setEndTime(DEFAULT_SHIFT_END_TIME);
      setSavedStartKey(null);
    }
    setShowDatePicker(null);
    setConflictsByTechnician({});
    setNoteText("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, currentScheduledStart, currentScheduledEnd, currentScheduleDaily, currentScheduleAllDay, currentScheduledCostCenterId]);

  // The "All day" default and the conflict warning look at the START day.
  const dateKey = startDateKey;

  function toggleTechnician(id: string) {
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

  async function confirm() {
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
        <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheet} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>Schedule job</Text>

          {step === "technician" && (
            <View style={{ gap: 6 }}>
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
              <Text style={styles.confirmTech}>{selectedTechnicians.map((t) => t.full_name).join(", ")}</Text>
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
                  ? onClose()
                  : setStep(
                      step === "confirm"
                        ? "notes"
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
              <TouchableOpacity style={[styles.doneBtn, technicianIds.length === 0 && styles.doneBtnDisabled]} onPress={() => setStep("time")} disabled={technicianIds.length === 0}>
                <Text style={styles.doneText}>Next</Text>
              </TouchableOpacity>
            )}
            {step === "time" && (
              <TouchableOpacity
                style={[styles.doneBtn, !!windowError && styles.doneBtnDisabled]}
                onPress={() => setStep(hasCostCenters ? "stage" : "notes")}
                disabled={!!windowError}
              >
                <Text style={styles.doneText}>Next</Text>
              </TouchableOpacity>
            )}
            {step === "stage" && (
              <TouchableOpacity style={styles.doneBtn} onPress={() => setStep("notes")}>
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
                <Text style={styles.doneText}>{saving ? "Scheduling…" : "Confirm"}</Text>
              </TouchableOpacity>
            )}
          </View>
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
});
