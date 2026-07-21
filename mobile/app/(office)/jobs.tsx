import { useCallback, useEffect, useState } from "react";
import { View, Text, FlatList, StyleSheet, RefreshControl, TextInput } from "react-native";
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

export default function OfficeJobsScreen() {
  const router = useRouter();
  const [jobs, setJobs] = useState<OfficeJob[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("jobs")
      .select("*, customers(name), assigned_profile:profiles!jobs_assigned_to_fkey(full_name)")
      .order("created_at", { ascending: false })
      .limit(200);
    setJobs((data as unknown as OfficeJob[]) ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? jobs.filter(
        (j) =>
          String(j.job_number).includes(q) ||
          j.title?.toLowerCase().includes(q) ||
          j.customers?.name?.toLowerCase().includes(q)
      )
    : jobs;

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
            placeholder="Search job #, title, customer"
            placeholderTextColor={colors.slate400}
            autoCorrect={false}
          />
        </View>
      </View>
      <FlatList
        data={filtered}
        keyExtractor={(j) => j.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.blue600} />}
        ListEmptyComponent={<Text style={styles.empty}>No jobs found.</Text>}
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
