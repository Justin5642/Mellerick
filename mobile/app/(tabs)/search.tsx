import { useCallback, useMemo, useState } from "react";
import {
  View,
  Text,
  Image,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Linking,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, useRouter } from "expo-router";
import { supabase } from "../../lib/supabase";
import { colors, statusColors } from "../../lib/theme";

interface Job {
  id: string;
  job_number: number;
  title: string;
  status: string;
  scheduled_start: string | null;
  customers: { name: string } | null;
  sites: { name: string; address_line1: string; suburb: string; site_lat: number | null; site_lng: number | null } | null;
}

export default function SearchJobsScreen() {
  const router = useRouter();
  const [allJobs, setAllJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

  const loadJobs = useCallback(async () => {
    // No assigned_to / status filter — techs need to find ANY job in the
    // system (completed or not, theirs or not) to reference photos/plans.
    // NOTE: capped at 10,000 rather than left unbounded purely as a sanity
    // ceiling — as of writing the whole system has ~500 jobs total, so this
    // comfortably covers every job with a lot of headroom for growth. If
    // this business ever gets into the tens of thousands of jobs, swap this
    // for server-side filtering (Postgres ilike query per keystroke) instead
    // of pulling the full table client-side.
    const { data } = await supabase
      .from("jobs")
      .select("id, job_number, title, status, scheduled_start, customers(name), sites(name, address_line1, suburb, site_lat, site_lng)")
      .order("created_at", { ascending: false })
      .limit(10000);
    setAllJobs((data as any) ?? []);
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadJobs();
    }, [loadJobs])
  );

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return allJobs
      .filter((j) => {
        const haystack = [
          String(j.job_number),
          j.title,
          j.customers?.name,
          j.sites?.name,
          j.sites?.address_line1,
          j.sites?.suburb,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return haystack.includes(q);
      })
      .slice(0, 50);
  }, [allJobs, query]);

  function openWaze(job: Job) {
    const site = job.sites;
    if (!site) return;
    const url =
      site.site_lat && site.site_lng
        ? `https://waze.com/ul?ll=${site.site_lat},${site.site_lng}&navigate=yes`
        : `https://waze.com/ul?q=${encodeURIComponent(`${site.address_line1}, ${site.suburb}`)}&navigate=yes`;
    Linking.openURL(url);
  }

  function JobRow({ job }: { job: Job }) {
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
        {job.sites && (
          <TouchableOpacity style={styles.wazeButton} onPress={() => openWaze(job)}>
            <Text style={styles.wazeButtonText}>Navigate</Text>
          </TouchableOpacity>
        )}
      </TouchableOpacity>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Image source={require("../../assets/logo.png")} style={styles.headerLogo} resizeMode="contain" />
        <Text style={styles.headerTitle}>Search Jobs</Text>
      </View>

      <View style={styles.searchBox}>
        <Ionicons name="search" size={18} color={colors.slate400} />
        <TextInput
          style={styles.searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="Job number, customer, or address"
          placeholderTextColor={colors.slate400}
          autoCapitalize="none"
          returnKeyType="search"
        />
      </View>

      {loading ? (
        <ActivityIndicator size="large" color={colors.blue600} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={results}
          keyExtractor={(j) => j.id}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => <JobRow job={item} />}
          ListEmptyComponent={
            <Text style={styles.emptyText}>
              {query.trim()
                ? "No jobs match your search."
                : "Search across every job in the system — scheduled or not, yours or not — to pull up photos and plans on the fly."}
            </Text>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 12,
  },
  headerLogo: { width: 34, height: 34 },
  headerTitle: { fontSize: 22, fontWeight: "700", color: colors.slate900 },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  searchInput: { flex: 1, fontSize: 15, color: colors.slate900 },
  listContent: { paddingHorizontal: 16, paddingBottom: 24 },
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
  emptyText: { textAlign: "center", color: colors.slate400, marginTop: 60, fontSize: 14, paddingHorizontal: 20, lineHeight: 20 },
});
