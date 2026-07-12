import { useState } from "react";
import { View, Text, StyleSheet, TextInput, TouchableOpacity, Linking, Alert, Modal, FlatList } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../lib/supabase";
import { colors } from "../../lib/theme";
import { JobHoursScoreboard } from "./hours-scoreboard";

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;

const STATUS_OPTIONS = [
  { label: "Pending", value: "pending" },
  { label: "Scheduled", value: "scheduled" },
  { label: "In Progress", value: "in_progress" },
  { label: "Completed", value: "completed" },
  { label: "On Hold", value: "on_hold" },
  { label: "Cancelled", value: "cancelled" },
];

const PRIORITY_OPTIONS = [
  { label: "Low", value: "low" },
  { label: "Normal", value: "normal" },
  { label: "High", value: "high" },
  { label: "Urgent", value: "urgent" },
];

// Tap-to-open modal list instead of an always-visible inline wheel picker.
// The old @react-native-picker/picker <Picker> renders as a spinning wheel
// embedded directly in the page on iOS — swiping over it to scroll the
// screen also spins the wheel, silently changing the selected status/
// priority. Requiring an explicit tap to open a selection list means
// scrolling past this field can never change its value.
function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { label: string; value: string }[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <>
      <Text style={styles.label}>{label}</Text>
      <TouchableOpacity style={styles.selectField} onPress={() => setOpen(true)}>
        <Text style={styles.selectFieldText}>{current?.label ?? value}</Text>
        <Ionicons name="chevron-down" size={18} color={colors.slate400} />
      </TouchableOpacity>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setOpen(false)}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>{label}</Text>
            <FlatList
              data={options}
              keyExtractor={(o) => o.value}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.modalRow}
                  onPress={() => {
                    onChange(item.value);
                    setOpen(false);
                  }}
                >
                  <Text style={[styles.modalRowText, item.value === value && styles.modalRowTextActive]}>{item.label}</Text>
                  {item.value === value && <Ionicons name="checkmark" size={18} color={colors.blue600} />}
                </TouchableOpacity>
              )}
            />
          </View>
        </TouchableOpacity>
      </Modal>
    </>
  );
}

interface Job {
  id: string;
  status: string;
  priority: string;
  description: string | null;
  notes: string | null;
  job_type: string | null;
  created_at: string;
  scheduled_start: string | null;
  actual_start: string | null;
  actual_end: string | null;
  customers: { name: string; phone: string | null; mobile: string | null; email: string | null } | null;
  sites: {
    name: string;
    address_line1: string;
    suburb: string;
    state: string | null;
    postcode: string | null;
    site_lat: number | null;
    site_lng: number | null;
  } | null;
  overtime_reason?: string | null;
  overtime_category?: string | null;
}

export function JobOverviewTab({ job, currentUserId }: { job: Job; currentUserId: string | null }) {
  const [status, setStatus] = useState(job.status);
  const [priority, setPriority] = useState(job.priority);
  const [description, setDescription] = useState(job.description ?? "");
  const [notes, setNotes] = useState(job.notes ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const { error } = await supabase
      .from("jobs")
      .update({ status, priority, description, notes })
      .eq("id", job.id);
    setSaving(false);
    if (error) {
      Alert.alert("Error", error.message);
      return;
    }
    if (API_BASE_URL) {
      fetch(`${API_BASE_URL}/api/jobs/${job.id}/sync-calendar`, { method: "POST" }).catch(() => {});
    }
    Alert.alert("Saved", "Job updated");
  }

  function openWaze() {
    const site = job.sites;
    if (!site) return;
    if (site.site_lat && site.site_lng) {
      Linking.openURL(`https://waze.com/ul?ll=${site.site_lat},${site.site_lng}&navigate=yes`);
      return;
    }
    const query = encodeURIComponent(`${site.address_line1} ${site.suburb} ${site.state ?? ""}`);
    Linking.openURL(`https://waze.com/ul?q=${query}&navigate=yes`);
  }

  return (
    <View style={styles.container}>
      <JobHoursScoreboard job={job} currentUserId={currentUserId} />

      <Text style={styles.sectionTitle}>Status & Priority</Text>
      <View style={styles.card}>
        <SelectField label="Status" value={status} options={STATUS_OPTIONS} onChange={setStatus} />
        <SelectField label="Priority" value={priority} options={PRIORITY_OPTIONS} onChange={setPriority} />

        <Text style={styles.label}>Description</Text>
        <TextInput
          style={[styles.input, styles.textArea]}
          value={description}
          onChangeText={setDescription}
          multiline
          placeholder="Job description..."
        />

        <Text style={styles.label}>Internal Notes</Text>
        <TextInput
          style={[styles.input, styles.textArea]}
          value={notes}
          onChangeText={setNotes}
          multiline
          placeholder="Notes for the technician..."
        />

        <TouchableOpacity style={styles.saveButton} onPress={save} disabled={saving}>
          <Text style={styles.saveButtonText}>{saving ? "Saving..." : "Save Changes"}</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.sectionTitle}>Customer</Text>
      <View style={styles.card}>
        <Text style={styles.customerName}>{job.customers?.name ?? "—"}</Text>
        {job.customers?.phone && (
          <TouchableOpacity onPress={() => Linking.openURL(`tel:${job.customers?.phone}`)}>
            <Text style={styles.link}>📞 {job.customers.phone}</Text>
          </TouchableOpacity>
        )}
        {job.customers?.mobile && (
          <TouchableOpacity onPress={() => Linking.openURL(`tel:${job.customers?.mobile}`)}>
            <Text style={styles.link}>📱 {job.customers.mobile} (mobile)</Text>
          </TouchableOpacity>
        )}
        {job.customers?.email && (
          <TouchableOpacity onPress={() => Linking.openURL(`mailto:${job.customers?.email}`)}>
            <Text style={styles.link}>✉️ {job.customers.email}</Text>
          </TouchableOpacity>
        )}
      </View>

      {job.sites && (
        <>
          <Text style={styles.sectionTitle}>Site</Text>
          <View style={styles.card}>
            <Text style={styles.customerName}>{job.sites.name}</Text>
            <Text style={styles.meta}>{job.sites.address_line1}</Text>
            <Text style={styles.meta}>
              {job.sites.suburb} {job.sites.state} {job.sites.postcode}
            </Text>
            <TouchableOpacity onPress={openWaze}>
              <Text style={styles.link}>🧭 Navigate with Waze</Text>
            </TouchableOpacity>
          </View>
        </>
      )}

      <Text style={styles.sectionTitle}>Timeline</Text>
      <View style={styles.card}>
        <View style={styles.timelineRow}>
          <Text style={styles.meta}>Created</Text>
          <Text style={styles.meta}>{new Date(job.created_at).toLocaleDateString("en-AU")}</Text>
        </View>
        {job.scheduled_start && (
          <View style={styles.timelineRow}>
            <Text style={styles.meta}>Scheduled</Text>
            <Text style={styles.meta}>{new Date(job.scheduled_start).toLocaleDateString("en-AU")}</Text>
          </View>
        )}
        {job.actual_start && (
          <View style={styles.timelineRow}>
            <Text style={styles.meta}>Started</Text>
            <Text style={styles.meta}>{new Date(job.actual_start).toLocaleDateString("en-AU")}</Text>
          </View>
        )}
        {job.actual_end && (
          <View style={styles.timelineRow}>
            <Text style={styles.meta}>Completed</Text>
            <Text style={styles.meta}>{new Date(job.actual_end).toLocaleDateString("en-AU")}</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16 },
  sectionTitle: { fontSize: 13, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginBottom: 8, marginTop: 12 },
  card: { backgroundColor: colors.card, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: colors.border },
  label: { fontSize: 13, fontWeight: "600", color: colors.slate700, marginBottom: 6, marginTop: 10 },
  selectField: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    backgroundColor: colors.bg,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  selectFieldText: { fontSize: 14, color: colors.slate900, fontWeight: "500" },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  modalSheet: { backgroundColor: colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingBottom: 24, maxHeight: "60%" },
  modalTitle: { fontSize: 13, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", padding: 16, paddingBottom: 8 },
  modalRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  modalRowText: { fontSize: 15, color: colors.slate900 },
  modalRowTextActive: { color: colors.blue600, fontWeight: "600" },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    backgroundColor: colors.bg,
    color: colors.slate900,
  },
  textArea: { minHeight: 70, textAlignVertical: "top" },
  saveButton: { backgroundColor: colors.blue600, borderRadius: 10, paddingVertical: 12, alignItems: "center", marginTop: 16 },
  saveButtonText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  customerName: { fontSize: 15, fontWeight: "600", color: colors.slate900, marginBottom: 6 },
  link: { color: colors.blue600, fontSize: 13, marginTop: 4 },
  meta: { fontSize: 13, color: colors.slate500 },
  timelineRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
});
