import { useEffect, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Modal, Alert, Platform } from "react-native";
import DateTimePicker, { type DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { listAssignableStaff, countOtherScheduledJobs, type AssignableStaff } from "../../lib/data/reads/schedule";
import { useSchedule } from "../../lib/data/hooks/useSchedule";
import {
  DEFAULT_SHIFT_START_TIME,
  DEFAULT_SHIFT_END_TIME,
  defaultAllDay,
  validateScheduleWindow,
} from "../../lib/scheduling";
import { dateKeyInBusinessTZ, toBusinessInputValue, fromBusinessInputValue } from "../../lib/date";

interface Props {
  visible: boolean;
  onClose: () => void;
  jobId: string;
  jobStatus: string;
  currentAssignedTo: string | null;
  currentScheduledStart: string | null;
  currentScheduledEnd: string | null;
  onScheduled: (patch: {
    assigned_to: string;
    assigned_profile: { full_name: string };
    scheduled_start: string;
    scheduled_end: string;
    status: string;
  }) => void;
}

type Step = "technician" | "time" | "confirm";

function friendlyTime(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const period = h < 12 ? "am" : "pm";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")}${period}`;
}

/**
 * Mobile twin of the web job detail's "Schedule Job" dialog — same 3 steps
 * (technician, time with an All day toggle, confirm), same shared rules
 * (lib/scheduling.ts), writing through ScheduleRepository.schedule() so the
 * update is one durable outbox entry with a coalesced calendar sync, exactly
 * like the web dialog's single applyScheduleChange call.
 */
export function ScheduleJobModal({
  visible,
  onClose,
  jobId,
  jobStatus,
  currentAssignedTo,
  currentScheduledStart,
  currentScheduledEnd,
  onScheduled,
}: Props) {
  const { schedule, ready } = useSchedule();
  const [step, setStep] = useState<Step>("technician");
  const [staff, setStaff] = useState<AssignableStaff[]>([]);
  const [technician, setTechnician] = useState<AssignableStaff | null>(null);
  const [date, setDate] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [allDay, setAllDay] = useState(true);
  const [startTime, setStartTime] = useState(DEFAULT_SHIFT_START_TIME);
  const [endTime, setEndTime] = useState(DEFAULT_SHIFT_END_TIME);
  const [showTimePicker, setShowTimePicker] = useState<"start" | "end" | null>(null);
  const [otherJobsThatDay, setOtherJobsThatDay] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible) return;
    listAssignableStaff().then(setStaff).catch(() => {});
    setStep("technician");
    setTechnician(null);
    setDate(currentScheduledStart ? new Date(currentScheduledStart) : new Date());
    if (currentScheduledStart && currentScheduledEnd) {
      setAllDay(false);
      setStartTime(toBusinessInputValue(currentScheduledStart).slice(11));
      setEndTime(toBusinessInputValue(currentScheduledEnd).slice(11));
    } else {
      setAllDay(true);
      setStartTime(DEFAULT_SHIFT_START_TIME);
      setEndTime(DEFAULT_SHIFT_END_TIME);
    }
    setOtherJobsThatDay(null);
  }, [visible, currentScheduledStart, currentScheduledEnd]);

  // Pre-select the currently assigned technician once the staff list has
  // loaded (it isn't known until listAssignableStaff resolves).
  useEffect(() => {
    if (!currentAssignedTo || technician) return;
    const match = staff.find((s) => s.id === currentAssignedTo);
    if (match) setTechnician(match);
  }, [staff, currentAssignedTo, technician]);

  const dateKey = dateKeyInBusinessTZ(date);

  // Smart default, same rule as the web dialog: zero other jobs that day ->
  // All day stays on; one or more -> default off for a custom block.
  useEffect(() => {
    if (!visible || step !== "time" || !technician) return;
    let cancelled = false;
    countOtherScheduledJobs(technician.id, dateKey, jobId)
      .then((n) => {
        if (cancelled) return;
        setOtherJobsThatDay(n);
        const nextAllDay = defaultAllDay(n);
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
  }, [visible, step, technician, dateKey, jobId]);

  function toggleAllDay() {
    const next = !allDay;
    setAllDay(next);
    if (next) {
      setStartTime(DEFAULT_SHIFT_START_TIME);
      setEndTime(DEFAULT_SHIFT_END_TIME);
    }
  }

  function onDateChange(event: DateTimePickerEvent, selected?: Date) {
    setShowDatePicker(Platform.OS === "ios");
    if (event.type === "set" && selected) setDate(selected);
  }

  function onTimeChange(which: "start" | "end", event: DateTimePickerEvent, selected?: Date) {
    setShowTimePicker(Platform.OS === "ios" ? which : null);
    if (event.type !== "set" || !selected) return;
    const hhmm = `${String(selected.getHours()).padStart(2, "0")}:${String(selected.getMinutes()).padStart(2, "0")}`;
    if (which === "start") setStartTime(hhmm);
    else setEndTime(hhmm);
  }

  const scheduledStartIso = fromBusinessInputValue(`${dateKey}T${startTime}`);
  const scheduledEndIso = fromBusinessInputValue(`${dateKey}T${endTime}`);
  const windowError = validateScheduleWindow(scheduledStartIso, scheduledEndIso);

  function timeAsDate(hhmm: string): Date {
    const [h, m] = hhmm.split(":").map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d;
  }

  async function confirm() {
    if (!technician || windowError || saving || !ready) return;
    setSaving(true);
    try {
      await schedule(jobId, technician.id, scheduledStartIso, scheduledEndIso);
      onScheduled({
        assigned_to: technician.id,
        assigned_profile: { full_name: technician.full_name },
        scheduled_start: scheduledStartIso,
        scheduled_end: scheduledEndIso,
        status: jobStatus === "pending" ? "scheduled" : jobStatus,
      });
      onClose();
    } catch (e) {
      Alert.alert("Couldn't schedule", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setSaving(false);
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
                const active = technician?.id === s.id;
                return (
                  <TouchableOpacity
                    key={s.id}
                    style={[styles.row, active && styles.rowActive]}
                    onPress={() => setTechnician(s)}
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
              <View>
                <Text style={styles.label}>Date</Text>
                <TouchableOpacity style={styles.selector} onPress={() => setShowDatePicker(true)}>
                  <Text style={styles.selectorText}>{date.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" })}</Text>
                  <Ionicons name="calendar-outline" size={16} color={colors.slate400} />
                </TouchableOpacity>
                {showDatePicker && <DateTimePicker value={date} mode="date" onChange={onDateChange} />}
              </View>

              <TouchableOpacity style={styles.allDayRow} onPress={toggleAllDay}>
                <Ionicons name={allDay ? "checkbox" : "square-outline"} size={20} color={allDay ? colors.blue600 : colors.slate400} />
                <Text style={styles.allDayText}>
                  All day ({friendlyTime(DEFAULT_SHIFT_START_TIME)} – {friendlyTime(DEFAULT_SHIFT_END_TIME)})
                </Text>
              </TouchableOpacity>

              {otherJobsThatDay !== null && otherJobsThatDay > 0 && (
                <Text style={styles.warnHint}>
                  {technician?.full_name ?? "This technician"} already has {otherJobsThatDay} job{otherJobsThatDay === 1 ? "" : "s"} that day — set a custom time block below.
                </Text>
              )}

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
              {showTimePicker && (
                <DateTimePicker
                  value={timeAsDate(showTimePicker === "start" ? startTime : endTime)}
                  mode="time"
                  onChange={(e, d) => onTimeChange(showTimePicker, e, d)}
                />
              )}

              {windowError && <Text style={styles.errorText}>{windowError}</Text>}
            </View>
          )}

          {step === "confirm" && (
            <View style={styles.confirmBox}>
              <Text style={styles.confirmTech}>{technician?.full_name}</Text>
              <Text style={styles.confirmLine}>
                {new Date(scheduledStartIso).toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", timeZone: "Australia/Melbourne" })}
              </Text>
              <Text style={styles.confirmLine}>
                {new Date(scheduledStartIso).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", timeZone: "Australia/Melbourne" })}
                {" – "}
                {new Date(scheduledEndIso).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", timeZone: "Australia/Melbourne" })}
                {allDay ? " · All day" : ""}
              </Text>
              <Text style={styles.hint}>
                This sets the planned schedule block only — worked hours are still captured separately via clock-on/clock-off.
              </Text>
            </View>
          )}

          <View style={styles.actions}>
            <TouchableOpacity
              style={styles.cancelBtn}
              onPress={() => (step === "technician" ? onClose() : setStep(step === "confirm" ? "time" : "technician"))}
              disabled={saving}
            >
              <Text style={styles.cancelText}>{step === "technician" ? "Cancel" : "Back"}</Text>
            </TouchableOpacity>
            {step === "technician" && (
              <TouchableOpacity style={[styles.doneBtn, !technician && styles.doneBtnDisabled]} onPress={() => setStep("time")} disabled={!technician}>
                <Text style={styles.doneText}>Next</Text>
              </TouchableOpacity>
            )}
            {step === "time" && (
              <TouchableOpacity style={[styles.doneBtn, !!windowError && styles.doneBtnDisabled]} onPress={() => setStep("confirm")} disabled={!!windowError}>
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
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheetScroll: { maxHeight: "88%", flexGrow: 0 },
  sheet: { backgroundColor: colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, paddingBottom: 28 },
  title: { fontSize: 16, fontWeight: "800", color: colors.slate900, marginBottom: 12 },
  hint: { fontSize: 12, color: colors.slate400, marginTop: 4 },
  warnHint: { fontSize: 12, color: colors.yellow700 },
  errorText: { fontSize: 12, color: colors.red600 },
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
