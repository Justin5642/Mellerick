import { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { supabase } from "../../lib/supabase";
import { colors, statusColors } from "../../lib/theme";
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

export default function JobDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [job, setJob] = useState<any>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabKey>("overview");

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
        <View style={[styles.badge, { backgroundColor: sc.bg }]}>
          <Text style={[styles.badgeText, { color: sc.text }]}>{job.status.replace("_", " ")}</Text>
        </View>
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
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  badgeText: { fontSize: 11, fontWeight: "600", textTransform: "capitalize" },
  subtitle: { fontSize: 13, color: colors.slate500, paddingHorizontal: 16, marginTop: 2 },
  tabBarWrap: { borderBottomWidth: 1, borderBottomColor: colors.border, marginTop: 12 },
  tabBar: { paddingHorizontal: 12, gap: 4 },
  tab: { paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 2, borderBottomColor: "transparent" },
  tabActive: { borderBottomColor: colors.blue600 },
  tabText: { fontSize: 13, fontWeight: "600", color: colors.slate500 },
  tabTextActive: { color: colors.blue600 },
  content: { flex: 1 },
});
