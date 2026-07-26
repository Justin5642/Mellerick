import { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Modal, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../lib/supabase";
import { colors, statusColors } from "../../lib/theme";
import { useIsOfficeOrAdmin } from "../../design/guards/useRole";
import { useJobEdit } from "../../lib/data/hooks/useJobEdit";
import { JobOverviewTab } from "../../components/job/overview";
import { JobNotesTab } from "../../components/job/notes";
import { JobPhotosTab } from "../../components/job/photos";
import { JobTimeTab } from "../../components/job/time";
import { JobSignatureTab } from "../../components/job/signature";
import { JobDocumentsTab } from "../../components/job/documents";
import { JobVariationsTab } from "../../components/job/variations";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "time", label: "Time" },
  { key: "variations", label: "Variations" },
  { key: "photos", label: "Photos" },
  { key: "documents", label: "Documents" },
  { key: "notes", label: "Notes" },
  { key: "signature", label: "Signature" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const JOB_STATUSES = ["pending", "scheduled", "in_progress", "on_hold", "completed", "cancelled"] as const;
const JOB_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export default function JobDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const isOfficeOrAdmin = useIsOfficeOrAdmin();
  const jobEdit = useJobEdit();
  const [job, setJob] = useState<any>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabKey>("overview");
  const [editing, setEditing] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);

  const loadJob = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    setUserId(user?.id ?? null);

    const { data } = await supabase
      .from("jobs")
      .select(
        "id, job_number, title, status, priority, description, notes, job_type, created_at, scheduled_start, scheduled_end, actual_start, actual_end, completion_notes, overtime_reason, overtime_category, voice_report_transcript, customers(name, phone, mobile, email), sites(name, address_line1, suburb, state, postcode, site_lat, site_lng)"
      )
      .eq("id", id)
      .single();
    setJob(data);
    setLoading(false);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      loadJob();
    }, [loadJob])
  );

  // Office/admin quick-edit of a job's own status/priority (offline-durable).
  // Applies the change optimistically; completion is still owned by the
  // sign-off flow — this is for dispatch/triage status changes.
  const applyEdit = useCallback(
    async (fields: { status?: string; priority?: string }) => {
      if (savingEdit || !jobEdit.ready) return;
      setSavingEdit(true);
      try {
        await jobEdit.updateFields(id, fields);
        setJob((j: any) => ({ ...j, ...fields }));
        setEditing(false);
      } catch (e) {
        Alert.alert("Couldn't update", e instanceof Error ? e.message : "Please try again.");
      } finally {
        setSavingEdit(false);
      }
    },
    [id, jobEdit, savingEdit]
  );

  if (loading || !job) {
    return (
      <SafeAreaView style={styles.center} edges={["bottom", "left", "right"]}>
        <ActivityIndicator size="large" color={colors.blue600} />
      </SafeAreaView>
    );
  }

  const sc = statusColors[job.status] ?? statusColors.pending;

  return (
    <SafeAreaView style={styles.container} edges={["bottom", "left", "right"]}>
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          #{job.job_number} — {job.title}
        </Text>
        {isOfficeOrAdmin && (
          <TouchableOpacity style={styles.billingBtn} onPress={() => router.push(`/job/${id}/billing`)} accessibilityLabel="Job billing">
            <Ionicons name="cash-outline" size={14} color={colors.blue600} />
            <Text style={styles.billingText}>Billing</Text>
          </TouchableOpacity>
        )}
        {isOfficeOrAdmin ? (
          <TouchableOpacity style={[styles.badge, styles.badgeEditable, { backgroundColor: sc.bg }]} onPress={() => setEditing(true)} accessibilityLabel="Edit job status">
            <Text style={[styles.badgeText, { color: sc.text }]}>{job.status.replace("_", " ")}</Text>
            <Ionicons name="chevron-down" size={11} color={sc.text} />
          </TouchableOpacity>
        ) : (
          <View style={[styles.badge, { backgroundColor: sc.bg }]}>
            <Text style={[styles.badgeText, { color: sc.text }]}>{job.status.replace("_", " ")}</Text>
          </View>
        )}
      </View>
      <Text style={styles.subtitle}>
        {job.customers?.name}
        {job.sites ? ` · ${job.sites.name}, ${job.sites.suburb}` : ""}
      </Text>

      <View style={styles.tabBarWrap}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabBar}>
          {TABS.map((t) => (
            <TouchableOpacity key={t.key} style={[styles.tab, tab === t.key && styles.tabActive]} onPress={() => setTab(t.key)}>
              <Text style={[styles.tabText, tab === t.key && styles.tabTextActive]}>{t.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      <ScrollView style={styles.content} contentContainerStyle={{ paddingBottom: 40 }}>
        {tab === "overview" && <JobOverviewTab job={job} currentUserId={userId} />}
        {tab === "time" && userId && <JobTimeTab jobId={job.id} currentUserId={userId} />}
        {tab === "variations" && userId && <JobVariationsTab jobId={job.id} currentUserId={userId} />}
        {tab === "photos" && userId && (
          <JobPhotosTab
            jobId={job.id}
            currentUserId={userId}
            jobNumber={job.job_number}
            siteLabel={job.sites ? `${job.sites.address_line1}, ${job.sites.suburb}` : null}
          />
        )}
        {tab === "documents" && <JobDocumentsTab jobId={job.id} />}
        {tab === "notes" && userId && <JobNotesTab jobId={job.id} currentUserId={userId} />}
        {tab === "signature" && userId && (
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
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Update job</Text>
            <Text style={styles.sheetLabel}>Status</Text>
            <View style={styles.chipWrap}>
              {JOB_STATUSES.map((s) => {
                const c = statusColors[s] ?? statusColors.pending;
                const active = job.status === s;
                return (
                  <TouchableOpacity key={s} style={[styles.chip, active && { backgroundColor: c.bg, borderColor: c.text }]} onPress={() => applyEdit({ status: s })} disabled={savingEdit}>
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
                  <TouchableOpacity key={p} style={[styles.chip, active && styles.chipActive]} onPress={() => applyEdit({ priority: p })} disabled={savingEdit}>
                    <Text style={[styles.chipText, active && styles.chipTextActive]}>{p}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <TouchableOpacity style={styles.doneBtn} onPress={() => setEditing(false)} disabled={savingEdit}>
              <Text style={styles.doneText}>Done</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
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
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  badgeEditable: { flexDirection: "row", alignItems: "center", gap: 3 },
  badgeText: { fontSize: 11, fontWeight: "600", textTransform: "capitalize" },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, paddingBottom: 28 },
  sheetTitle: { fontSize: 16, fontWeight: "800", color: colors.slate900, marginBottom: 8 },
  sheetLabel: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginTop: 12, marginBottom: 8 },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  chipActive: { backgroundColor: colors.blue600, borderColor: colors.blue600 },
  chipText: { fontSize: 13, fontWeight: "600", color: colors.slate700, textTransform: "capitalize" },
  chipTextActive: { color: "#fff" },
  doneBtn: { marginTop: 18, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.blue600, alignItems: "center" },
  doneText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  subtitle: { fontSize: 13, color: colors.slate500, paddingHorizontal: 16, marginTop: 2 },
  tabBarWrap: { borderBottomWidth: 1, borderBottomColor: colors.border, marginTop: 12 },
  tabBar: { paddingHorizontal: 12, gap: 4 },
  tab: { paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 2, borderBottomColor: "transparent" },
  tabActive: { borderBottomColor: colors.blue600 },
  tabText: { fontSize: 13, fontWeight: "600", color: colors.slate500 },
  tabTextActive: { color: colors.blue600 },
  content: { flex: 1 },
});
