import { useEffect, useState, type ReactNode } from "react";
import { View, Text, ScrollView, StyleSheet, TextInput, TouchableOpacity, Alert, Platform, Modal } from "react-native";
import { Stack, useRouter, useLocalSearchParams } from "expo-router";
import DateTimePicker, { type DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { useJobEdit } from "../../lib/data/hooks/useJobEdit";
import { useWriteOutcome } from "../../lib/data/hooks/useWriteOutcome";
import { CustomerPicker } from "../../components/finance/customer-picker";
import { getCustomer, type Site, type CustomerListRow } from "../../lib/data/reads/customers";
import { listAssignableStaff, type AssignableStaff } from "../../lib/data/reads/schedule";

const JOB_TYPES = ["service", "installation", "maintenance", "emergency", "quote"] as const;
const PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export default function NewJobScreen() {
  const router = useRouter();
  const { customerId } = useLocalSearchParams<{ customerId?: string }>();
  const { createJob, ready } = useJobEdit();
  const writeOutcome = useWriteOutcome();
  const [title, setTitle] = useState("");
  const [customer, setCustomer] = useState<CustomerListRow | null>(null);
  const [pickCustomer, setPickCustomer] = useState(false);
  const [sites, setSites] = useState<Site[]>([]);
  const [site, setSite] = useState<Site | null>(null);
  const [pickSite, setPickSite] = useState(false);
  const [staff, setStaff] = useState<AssignableStaff[]>([]);
  const [assignee, setAssignee] = useState<AssignableStaff | null>(null);
  const [pickAssignee, setPickAssignee] = useState(false);
  const [jobType, setJobType] = useState<(typeof JOB_TYPES)[number]>("service");
  const [priority, setPriority] = useState<(typeof PRIORITIES)[number]>("normal");
  const [schedDate, setSchedDate] = useState<Date | null>(null);
  const [showDate, setShowDate] = useState(false);
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);

  async function onSelectCustomer(c: CustomerListRow) {
    setCustomer(c);
    setPickCustomer(false);
    setSite(null);
    const detail = await getCustomer(c.id);
    setSites(detail?.sites ?? []);
  }

  // Pre-select the customer when launched from a customer's "New Job" shortcut.
  useEffect(() => {
    if (!customerId) return;
    let cancelled = false;
    getCustomer(customerId).then((detail) => {
      if (cancelled || !detail) return;
      setCustomer({ id: detail.id, name: detail.name } as CustomerListRow);
      setSites(detail.sites ?? []);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [customerId]);

  function openAssignee() {
    if (staff.length === 0) listAssignableStaff().then(setStaff).catch(() => {});
    setPickAssignee(true);
  }

  function onDateChange(event: DateTimePickerEvent, selected?: Date) {
    setShowDate(Platform.OS === "ios");
    if (event.type === "set" && selected) setSchedDate(selected);
  }

  async function save() {
    if (saving || !ready) return;
    if (!customer) { Alert.alert("Customer required", "Select a customer for this job."); return; }
    if (!title.trim()) { Alert.alert("Title required", "Enter a job title."); return; }
    setSaving(true);
    try {
      // Default the scheduled time to 8:00am local on the picked day (a full
      // start/end time editor is a web action for now).
      let scheduledStartIso: string | null = null;
      if (schedDate) {
        const d = new Date(schedDate);
        d.setHours(8, 0, 0, 0);
        scheduledStartIso = d.toISOString();
      }
      const { id, synced } = await createJob({
        customerId: customer.id,
        title: title.trim(),
        siteId: site?.id ?? null,
        assignedTo: assignee?.id ?? null,
        jobType,
        priority,
        status: scheduledStartIso ? "scheduled" : "pending",
        scheduledStartIso,
        description: description.trim() || null,
      });
      if (!synced) {
        Alert.alert("Saved offline", "The new job is queued and will sync when you're back online.");
        router.back();
      } else if ((await writeOutcome(id)) === "failed") {
        // Online but the server rejected the insert — don't navigate to a job
        // detail that would 404; it's queued and will retry.
        Alert.alert("Couldn't create the job", "The server rejected it — it's queued and will retry. Check the sync status for details.");
        router.back();
      } else {
        router.replace(`/job/${id}`);
      }
    } catch (e) {
      Alert.alert("Couldn't create job", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: "New Job" }} />

      <Text style={styles.label}>Title</Text>
      <TextInput style={styles.input} value={title} onChangeText={setTitle} placeholder="e.g. Annual backflow test" placeholderTextColor={colors.slate400} />

      <Text style={styles.label}>Customer</Text>
      <TouchableOpacity style={styles.selector} onPress={() => setPickCustomer(true)}>
        <Text style={[styles.selectorText, !customer && styles.placeholder]}>{customer ? customer.name : "Select customer…"}</Text>
        <Ionicons name="chevron-forward" size={16} color={colors.slate400} />
      </TouchableOpacity>

      {customer && (
        <>
          <Text style={styles.label}>Site (optional)</Text>
          <TouchableOpacity style={styles.selector} onPress={() => setPickSite(true)} disabled={sites.length === 0}>
            <Text style={[styles.selectorText, !site && styles.placeholder]}>
              {site ? `${site.name}${site.suburb ? ` · ${site.suburb}` : ""}` : sites.length ? "Select site…" : "No sites for this customer"}
            </Text>
            <Ionicons name="chevron-forward" size={16} color={colors.slate400} />
          </TouchableOpacity>
        </>
      )}

      <Text style={styles.label}>Assign to (optional)</Text>
      <TouchableOpacity style={styles.selector} onPress={openAssignee}>
        <Text style={[styles.selectorText, !assignee && styles.placeholder]}>{assignee ? assignee.full_name : "Unassigned"}</Text>
        <Ionicons name="chevron-forward" size={16} color={colors.slate400} />
      </TouchableOpacity>

      <Text style={styles.label}>Type</Text>
      <View style={styles.chips}>
        {JOB_TYPES.map((t) => (
          <Chip key={t} label={t} active={jobType === t} onPress={() => setJobType(t)} />
        ))}
      </View>

      <Text style={styles.label}>Priority</Text>
      <View style={styles.chips}>
        {PRIORITIES.map((p) => (
          <Chip key={p} label={p} active={priority === p} onPress={() => setPriority(p)} />
        ))}
      </View>

      <Text style={styles.label}>Schedule (optional)</Text>
      <TouchableOpacity style={styles.selector} onPress={() => setShowDate(true)}>
        <Text style={[styles.selectorText, !schedDate && styles.placeholder]}>{schedDate ? `${schedDate.toLocaleDateString("en-AU")} · 8:00am` : "Not scheduled"}</Text>
        <Ionicons name="calendar-outline" size={16} color={colors.slate400} />
      </TouchableOpacity>
      {showDate && <DateTimePicker value={schedDate ?? new Date()} mode="date" onChange={onDateChange} />}

      <Text style={[styles.label, { marginTop: 12 }]}>Description (optional)</Text>
      <TextInput style={[styles.input, styles.multiline]} value={description} onChangeText={setDescription} placeholder="What needs doing" placeholderTextColor={colors.slate400} multiline />

      <TouchableOpacity style={[styles.saveBtn, saving && styles.saveBtnDisabled]} onPress={save} disabled={saving}>
        <Text style={styles.saveText}>{saving ? "Saving…" : "Create job"}</Text>
      </TouchableOpacity>
      <Text style={styles.footnote}>The job number is assigned on sync. Full time-of-day scheduling is on the web.</Text>

      <CustomerPicker visible={pickCustomer} onClose={() => setPickCustomer(false)} onSelect={onSelectCustomer} />

      <PickerModal visible={pickSite} title="Select site" onClose={() => setPickSite(false)}>
        {sites.map((s) => (
          <TouchableOpacity key={s.id} style={styles.row} onPress={() => { setSite(s); setPickSite(false); }}>
            <Text style={styles.rowText}>{s.name}</Text>
            {s.suburb ? <Text style={styles.rowSub}>{s.suburb}</Text> : null}
          </TouchableOpacity>
        ))}
      </PickerModal>

      <PickerModal visible={pickAssignee} title="Assign to" onClose={() => setPickAssignee(false)}>
        <TouchableOpacity style={styles.row} onPress={() => { setAssignee(null); setPickAssignee(false); }}>
          <Text style={styles.rowText}>Unassigned</Text>
        </TouchableOpacity>
        {staff.map((s) => (
          <TouchableOpacity key={s.id} style={styles.row} onPress={() => { setAssignee(s); setPickAssignee(false); }}>
            <Text style={styles.rowText}>{s.full_name}</Text>
            <Text style={styles.rowSub}>{s.role}</Text>
          </TouchableOpacity>
        ))}
      </PickerModal>
    </ScrollView>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={[styles.chip, active && styles.chipActive]} onPress={onPress}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function PickerModal({ visible, title, onClose, children }: { visible: boolean; title: string; onClose: () => void; children: ReactNode }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <Text style={styles.sheetTitle}>{title}</Text>
          <ScrollView style={{ maxHeight: 360 }}>{children}</ScrollView>
          <TouchableOpacity style={styles.cancelBtn} onPress={onClose}><Text style={styles.cancelText}>Cancel</Text></TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 40 },
  label: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginBottom: 6, marginTop: 12 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, backgroundColor: colors.card, color: colors.slate900 },
  multiline: { minHeight: 64, textAlignVertical: "top" },
  selector: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12, backgroundColor: colors.card },
  selectorText: { fontSize: 14, color: colors.slate900, fontWeight: "500", flex: 1 },
  placeholder: { color: colors.slate400, fontWeight: "400" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card },
  chipActive: { backgroundColor: colors.blue600, borderColor: colors.blue600 },
  chipText: { fontSize: 13, fontWeight: "600", color: colors.slate700, textTransform: "capitalize" },
  chipTextActive: { color: "#fff" },
  saveBtn: { backgroundColor: colors.blue600, borderRadius: 10, paddingVertical: 14, alignItems: "center", marginTop: 22 },
  saveBtnDisabled: { opacity: 0.6 },
  saveText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  footnote: { fontSize: 11, color: colors.slate400, textAlign: "center", marginTop: 10 },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, paddingBottom: 28 },
  sheetTitle: { fontSize: 16, fontWeight: "800", color: colors.slate900, marginBottom: 8 },
  row: { paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.border },
  rowText: { fontSize: 15, fontWeight: "600", color: colors.slate900 },
  rowSub: { fontSize: 12, color: colors.slate400, textTransform: "capitalize", marginTop: 1 },
  cancelBtn: { marginTop: 12, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.bg, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  cancelText: { fontSize: 14, fontWeight: "600", color: colors.slate700 },
});
