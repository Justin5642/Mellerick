import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, SectionList, StyleSheet, RefreshControl, Modal, TouchableOpacity, ActivityIndicator, Alert, Platform, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import DateTimePicker, { type DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { supabase } from "../../lib/supabase";
import { colors } from "../../lib/theme";
import { JobListRow } from "../../design/components/JobListRow";
import { businessDayLabel, formatBusinessTime, computeReschedule, localDateKey } from "../../lib/date";
import { useSchedule } from "../../lib/data/hooks/useSchedule";
import { listAssignableStaff, type AssignableStaff } from "../../lib/data/reads/schedule";

interface SchedJob {
  id: string;
  job_number: number;
  title: string;
  status: string;
  scheduled_start: string;
  scheduled_end: string | null;
  assigned_to: string | null;
  customers: { name: string } | null;
  profiles?: { full_name: string } | null;
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
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("jobs")
      .select("*, customers(name), profiles!jobs_assigned_to_fkey(full_name)")
      .not("scheduled_start", "is", null)
      .not("status", "in", '("completed","cancelled")')
      .order("scheduled_start");
    setJobs((data as unknown as SchedJob[]) ?? []);
  }, []);

  useEffect(() => {
    load();
    listAssignableStaff().then(setStaff).catch(() => {});
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const sections = useMemo(() => {
    const map = new Map<string, SchedJob[]>();
    for (const j of jobs) {
      const key = businessDayLabel(j.scheduled_start);
      const arr = map.get(key);
      if (arr) arr.push(j);
      else map.set(key, [j]);
    }
    return Array.from(map, ([title, data]) => ({ title, data }));
  }, [jobs]);

  async function onReassign(assignedTo: string | null) {
    const job = reassignJob;
    if (!job || busy || !schedule.ready) return;
    setBusy(true);
    try {
      await schedule.reassign(job.id, assignedTo);
      setReassignJob(null);
      await load();
    } catch (e) {
      Alert.alert("Couldn't reassign", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function onDatePicked(event: DateTimePickerEvent, selected?: Date) {
    const job = datePickerFor;
    if (Platform.OS !== "ios") setDatePickerFor(null); // Android dialog closes itself
    if (event.type !== "set" || !selected || !job || !schedule.ready) return;
    setBusy(true);
    try {
      const { scheduledStartIso, scheduledEndIso } = computeReschedule(job.scheduled_start, job.scheduled_end, localDateKey(selected));
      await schedule.reschedule(job.id, scheduledStartIso, scheduledEndIso);
      setDatePickerFor(null);
      await load();
    } catch (e) {
      Alert.alert("Couldn't reschedule", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.h1}>Schedule</Text>
        <Text style={styles.sub}>Tap a job to reassign, reschedule or open it</Text>
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(j) => j.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.blue600} />}
        stickySectionHeadersEnabled={false}
        ListEmptyComponent={<Text style={styles.empty}>Nothing scheduled.</Text>}
        renderSectionHeader={({ section }) => <Text style={styles.dayHead}>{section.title}</Text>}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <JobListRow
              jobNumber={item.job_number}
              title={item.title}
              subtitle={`${item.customers?.name ?? "—"}${item.profiles?.full_name ? ` · ${item.profiles.full_name}` : " · Unassigned"}`}
              status={item.status}
              leading={
                <View style={styles.timeCol}>
                  <Text style={styles.timeStart}>{formatBusinessTime(item.scheduled_start)}</Text>
                  {item.scheduled_end ? <Text style={styles.timeEnd}>{formatBusinessTime(item.scheduled_end)}</Text> : null}
                </View>
              }
              onPress={() => setMenuJob(item)}
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
              {menuJob ? ` · ${formatBusinessTime(menuJob.scheduled_start)}` : ""}
            </Text>
            <Action icon="person-outline" label="Reassign technician" onPress={() => { setReassignJob(menuJob); setMenuJob(null); }} />
            <Action icon="calendar-outline" label="Reschedule day" onPress={() => { setDatePickerFor(menuJob); setMenuJob(null); }} />
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
        <DateTimePicker value={new Date(datePickerFor.scheduled_start)} mode="date" onChange={onDatePicked} />
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
  staffName: { fontSize: 15, fontWeight: "600", color: colors.slate900 },
  staffRole: { fontSize: 12, color: colors.slate400, textTransform: "capitalize", marginTop: 1 },
  cancelBtn: { marginTop: 12, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.bg, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  cancelText: { fontSize: 14, fontWeight: "600", color: colors.slate700 },
});
