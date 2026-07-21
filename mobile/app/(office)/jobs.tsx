import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, FlatList, StyleSheet, RefreshControl, TextInput, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { supabase } from "../../lib/supabase";
import { colors } from "../../lib/theme";
import { JobListRow } from "../../design/components/JobListRow";

interface OfficeJob {
  id: string;
  job_number: number;
  title: string;
  status: string;
  priority: string;
  customers: { name: string } | null;
  assigned_profile?: { full_name: string } | null;
}

const PAGE = 50;
const SELECT = "id, job_number, title, status, priority, customers(name), assigned_profile:profiles!jobs_assigned_to_fkey(full_name)";

export default function OfficeJobsScreen() {
  const router = useRouter();
  const [jobs, setJobs] = useState<OfficeJob[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [query, setQuery] = useState("");
  // Guards against out-of-order responses when the query changes mid-flight.
  const reqId = useRef(0);

  // Search hits the SERVER (title ilike / job_number) so older jobs beyond the
  // first page are still found — not a client-side filter over a capped list.
  const runSearch = useCallback(async (q: string) => {
    const id = ++reqId.current;
    const safe = q.replace(/[,()%]/g, " ").trim();
    let builder = supabase.from("jobs").select(SELECT).order("created_at", { ascending: false }).limit(PAGE);
    if (safe) {
      const numeric = /^\d+$/.test(safe);
      builder = builder.or(`title.ilike.%${safe}%${numeric ? `,job_number.eq.${safe}` : ""}`);
    }
    const { data } = await builder;
    if (id !== reqId.current) return; // a newer query superseded this one
    setJobs((data as unknown as OfficeJob[]) ?? []);
    setHasMore(!safe && (data?.length ?? 0) === PAGE);
  }, []);

  // Debounce the search box.
  useEffect(() => {
    const t = setTimeout(() => runSearch(query), 250);
    return () => clearTimeout(t);
  }, [query, runSearch]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await runSearch(query);
    setRefreshing(false);
  }, [query, runSearch]);

  // Infinite scroll (only when not searching).
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || query.trim()) return;
    setLoadingMore(true);
    const { data } = await supabase
      .from("jobs")
      .select(SELECT)
      .order("created_at", { ascending: false })
      .range(jobs.length, jobs.length + PAGE - 1);
    const next = (data as unknown as OfficeJob[]) ?? [];
    setJobs((prev) => [...prev, ...next]);
    setHasMore(next.length === PAGE);
    setLoadingMore(false);
  }, [loadingMore, hasMore, query, jobs.length]);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.h1}>Jobs</Text>
        <View style={styles.search}>
          <Ionicons name="search" size={16} color={colors.slate400} />
          <TextInput
            style={styles.searchInput}
            value={query}
            onChangeText={setQuery}
            placeholder="Search job # or title"
            placeholderTextColor={colors.slate400}
            autoCorrect={false}
          />
        </View>
      </View>
      <FlatList
        data={jobs}
        keyExtractor={(j) => j.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.blue600} />}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={<Text style={styles.empty}>No jobs found.</Text>}
        ListFooterComponent={loadingMore ? <ActivityIndicator style={{ paddingVertical: 16 }} color={colors.blue600} /> : null}
        renderItem={({ item }) => (
          <JobListRow
            jobNumber={item.job_number}
            title={item.title}
            subtitle={`${item.customers?.name ?? "—"}${item.assigned_profile?.full_name ? ` · ${item.assigned_profile.full_name}` : ""}`}
            status={item.status}
            priority={item.priority}
            onPress={() => router.push(`/job/${item.id}`)}
          />
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10, gap: 10 },
  h1: { fontSize: 22, fontWeight: "800", color: colors.slate900 },
  search: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8 },
  searchInput: { flex: 1, fontSize: 14, color: colors.slate900, padding: 0 },
  empty: { textAlign: "center", color: colors.slate400, marginTop: 40, fontSize: 13 },
});
