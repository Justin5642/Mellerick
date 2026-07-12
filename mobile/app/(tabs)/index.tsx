import { useCallback, useState } from "react";
import {
  View,
  Text,
  Image,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Linking,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { supabase } from "../../lib/supabase";
import { useAuth } from "../../lib/auth-context";
import { colors, statusColors } from "../../lib/theme";

interface Job {
  id: string;
  job_number: number;
  title: string;
  status: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  customers: { name: string } | null;
  sites: { name: string; address_line1: string; suburb: string; site_lat: number | null; site_lng: number | null } | null;
}

export default function MyJobsScreen() {
  const router = useRouter();
  const { profile, signOut } = useAuth();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadJobs = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    const { data } = await supabase
      .from("jobs")
      .select("id, job_number, title, status, scheduled_start, scheduled_end, customers(name), sites(name, address_line1, suburb, site_lat, site_lng)")
      .eq("assigned_to", user.id)
      .not("status", "in", '("completed","cancelled")')
      .order("scheduled_start", { ascending: true, nullsFirst: false });

    setJobs((data as any) ?? []);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadJobs();
    }, [loadJobs])
  );

  function onRefresh() {
    setRefreshing(true);
    loadJobs();
  }

  function formatTime(iso: string) {
    return new Date(iso).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" });
  }

  function formatDate(iso: string) {
    return new Date(iso).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
  }

  const today = new Date().toDateString();
  const todayJobs = jobs.filter((j) => j.scheduled_start && new Date(j.scheduled_start).toDateString() === today);
  const upcomingJobs = jobs.filter((j) => !j.scheduled_start || new Date(j.scheduled_start).toDateString() !== today);

  function openWaze(job: Job) {
    const site = job.sites;
    if (!site) return;
    const url =
      site.site_lat && site.site_lng
        ? `https://waze.com/ul?ll=${site.site_lat},${site.site_lng}&navigate=yes`
        : `https://waze.com/ul?q=${encodeURIComponent(`${site.address_line1}, ${site.suburb}`)}&navigate=yes`;
    Linking.openURL(url);
  }

  function JobCard({ job }: { job: Job }) {
    const sc = statusColors[job.status] ?? statusColors.pending;
    const address = job.sites ? `${job.sites.address_line1}, ${job.sites.suburb}` : null;
    return (
      <TouchableOpacity style={styles.card} onPress={() => router.push(`/job/${job.id}`)}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            #{job.job_number} — {job.title}
          </Text>
          <View style={[styles.badge, { backgroundColor: sc.bg }]}>
            <Text style={[styles.badgeText, { color: sc.text }]}>{job.status.replace("_", " ")}</Text>
          </View>
        </View>
        {job.customers?.name && <Text style={styles.cardSubtext}>{job.customers.name}</Text>}
        {address && <Text style={styles.cardMeta}>📍 {address}</Text>}
        {job.scheduled_start && (
          <Text style={styles.cardMeta}>
            🕐 {formatDate(job.scheduled_start)} · {formatTime(job.scheduled_start)}
            {job.scheduled_end ? ` – ${formatTime(job.scheduled_end)}` : ""}
          </Text>
        )}
        {job.sites && (
          <TouchableOpacity style={styles.wazeButton} onPress={() => openWaze(job)}>
            <Text style={styles.wazeButtonText}>Navigate</Text>
          </TouchableOpacity>
        )}
      </TouchableOpacity>
    );
  }

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator size="large" color={colors.blue600} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Image source={require("../../assets/logo.png")} style={styles.headerLogo} resizeMode="contain" />
          <View>
            <Text style={styles.headerTitle}>My Jobs</Text>
            <Text style={styles.headerSubtitle}>{profile?.full_name ?? ""}</Text>
          </View>
        </View>
        <TouchableOpacity onPress={signOut}>
          <Text style={styles.signOut}>Sign out</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={[
          ...(todayJobs.length > 0
            ? [{ type: "header" as const, key: "today-header", label: `Today (${todayJobs.length})` }]
            : []),
          ...todayJobs.map((j) => ({ type: "job" as const, key: j.id, job: j })),
          ...(upcomingJobs.length > 0
            ? [{ type: "header" as const, key: "upcoming-header", label: `Upcoming (${upcomingJobs.length})` }]
            : []),
          ...upcomingJobs.map((j) => ({ type: "job" as const, key: j.id, job: j })),
        ]}
        keyExtractor={(item) => item.key}
        contentContainerStyle={styles.listContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        renderItem={({ item }) => {
          if (item.type === "header") {
            return <Text style={styles.sectionHeader}>{(item as any).label}</Text>;
          }
          return <JobCard job={(item as any).job} />;
        }}
        ListEmptyComponent={
          <Text style={styles.emptyText}>No jobs assigned right now.</Text>
        }
      />
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
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 16,
  },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 10 },
  headerLogo: { width: 34, height: 34 },
  headerTitle: { fontSize: 22, fontWeight: "700", color: colors.slate900 },
  headerSubtitle: { fontSize: 13, color: colors.slate500, marginTop: 2 },
  signOut: { fontSize: 13, color: colors.red600, fontWeight: "600" },
  listContent: { paddingHorizontal: 16, paddingBottom: 24 },
  sectionHeader: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.slate500,
    textTransform: "uppercase",
    marginTop: 16,
    marginBottom: 8,
    marginLeft: 4,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  cardTitle: { fontSize: 15, fontWeight: "600", color: colors.slate900, flex: 1 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  badgeText: { fontSize: 11, fontWeight: "600", textTransform: "capitalize" },
  cardSubtext: { fontSize: 13, color: colors.slate500, marginTop: 4 },
  cardMeta: { fontSize: 12, color: colors.slate400, marginTop: 3 },
  wazeButton: {
    marginTop: 10,
    alignSelf: "flex-start",
    borderWidth: 1,
    borderColor: colors.blue100,
    backgroundColor: colors.blue100,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  wazeButtonText: { color: colors.blue600, fontSize: 12, fontWeight: "600" },
  emptyText: { textAlign: "center", color: colors.slate400, marginTop: 60, fontSize: 14 },
});
