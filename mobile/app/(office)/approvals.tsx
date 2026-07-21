import { useCallback, useEffect, useState } from "react";
import { View, Text, FlatList, StyleSheet, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { supabase } from "../../lib/supabase";
import { colors } from "../../lib/theme";
import { JobListRow } from "../../design/components/JobListRow";

interface ApprovalJob {
  id: string;
  job_number: number;
  title: string;
  status: string;
  actual_end: string | null;
  customers: { name: string } | null;
}

export default function ApprovalsScreen() {
  const router = useRouter();
  const [jobs, setJobs] = useState<ApprovalJob[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    // Jobs a technician has signed off (ready_to_invoice = true) — the office's
    // queue to turn into invoices. This is exactly what the mobile sign-off flow
    // sets, so a field sign-off surfaces here.
    const { data } = await supabase
      .from("jobs")
      .select("id, job_number, title, status, actual_end, customers(name)")
      .eq("ready_to_invoice", true)
      .order("actual_end", { ascending: false })
      .limit(200);
    setJobs((data as unknown as ApprovalJob[]) ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.h1}>Approvals</Text>
        <Text style={styles.sub}>Signed-off jobs ready to invoice</Text>
      </View>
      <FlatList
        data={jobs}
        keyExtractor={(j) => j.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.blue600} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="checkmark-done-outline" size={34} color={colors.slate400} />
            <Text style={styles.emptyText}>Nothing awaiting approval.</Text>
          </View>
        }
        renderItem={({ item }) => (
          <JobListRow
            jobNumber={item.job_number}
            title={item.title}
            subtitle={`${item.customers?.name ?? "—"}${item.actual_end ? ` · completed ${new Date(item.actual_end).toLocaleDateString("en-AU")}` : ""}`}
            status={item.status}
            onPress={() => router.push(`/job/${item.id}`)}
          />
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10 },
  h1: { fontSize: 22, fontWeight: "800", color: colors.slate900 },
  sub: { fontSize: 13, color: colors.slate500, marginTop: 2 },
  empty: { alignItems: "center", justifyContent: "center", paddingVertical: 50, gap: 10 },
  emptyText: { fontSize: 13, color: colors.slate400 },
});
