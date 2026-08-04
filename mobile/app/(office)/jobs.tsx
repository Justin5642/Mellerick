import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, FlatList, StyleSheet, RefreshControl, TextInput, ActivityIndicator, TouchableOpacity } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { listOfficeJobs, searchOfficeJobs } from "../../lib/data/reads/jobs";
import { colors } from "../../lib/theme";
import { JobListRow } from "../../design/components/JobListRow";
import { ScreenError } from "../../design/components/ScreenError";

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

export default function OfficeJobsScreen() {
  const router = useRouter();
  const [jobs, setJobs] = useState<OfficeJob[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<unknown>(null);
  // Guards against out-of-order responses when the query changes mid-flight.
  const reqId = useRef(0);

  // Search hits the SERVER (title ilike / job_number) so older jobs beyond the
  // first page are still found — not a client-side filter over a capped list.
  //
  // searchOfficeJobs now THROWS on a failed query instead of returning [] — an
  // empty list here used to mean "no jobs" whether or not the query worked.
  // Uncaught, that rejection would also skip every flag-clearing line below and
  // leave the refresh spinner turning forever.
  const runSearch = useCallback(async (q: string) => {
    const id = ++reqId.current;
    // Same strip the module applies internally — kept here only to decide hasMore.
    const safe = q.replace(/[,()%]/g, " ").trim();
    try {
      setError(null);
      const data = await searchOfficeJobs(q, PAGE);
      if (id !== reqId.current) return; // a newer query superseded this one
      setJobs(data);
      setHasMore(!safe && data.length === PAGE);
    } catch (e) {
      if (id !== reqId.current) return; // a superseded query's failure isn't the screen's state
      setError(e);
    }
  }, []);

  // Debounce the search box.
  useEffect(() => {
    const t = setTimeout(() => runSearch(query), 250);
    return () => clearTimeout(t);
  }, [query, runSearch]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await runSearch(query);
    } finally {
      // runSearch swallows its own failures, but this flag is owned here: if it
      // is ever left set the pull-to-refresh spinner never stops.
      setRefreshing(false);
    }
  }, [query, runSearch]);

  // Infinite scroll (only when not searching).
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || query.trim()) return;
    setLoadingMore(true);
    try {
      const next = await listOfficeJobs(jobs.length, PAGE);
      setJobs((prev) => [...prev, ...next]);
      setHasMore(next.length === PAGE);
    } catch (e) {
      setError(e);
    } finally {
      // Without this, a thrown page leaves loadingMore stuck true — a permanent
      // footer spinner, and the guard above then blocks every later page.
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, query, jobs.length]);

  // Checked BEFORE the list renders, so a failed load can never fall through to
  // the "No jobs found." empty state. That confusion is the entire bug.
  // Retrying goes through onRefresh so the existing spinner shows while it runs.
  if (error) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ScreenError
          error={error}
          onRetry={() => {
            onRefresh();
          }}
        />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={styles.h1}>Jobs</Text>
          <TouchableOpacity style={styles.newBtn} onPress={() => router.push("/jobs/new")} accessibilityLabel="New job">
            <Ionicons name="add" size={18} color="#fff" />
            <Text style={styles.newText}>New</Text>
          </TouchableOpacity>
        </View>
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
  titleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  h1: { fontSize: 22, fontWeight: "800", color: colors.slate900 },
  newBtn: { flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: colors.blue600, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  newText: { color: "#fff", fontWeight: "700", fontSize: 13 },
  search: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8 },
  searchInput: { flex: 1, fontSize: 14, color: colors.slate900, padding: 0 },
  empty: { textAlign: "center", color: colors.slate400, marginTop: 40, fontSize: 13 },
});
