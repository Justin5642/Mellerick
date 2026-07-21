import { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, RefreshControl, TouchableOpacity } from "react-native";
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
  updated_at: string | null;
  customers: { name: string } | null;
}
interface PendingVariation {
  id: string;
  variation_types: { name: string } | null;
  jobs: { id: string; job_number: number; title: string; customers: { name: string } | null } | null;
}

export default function ApprovalsScreen() {
  const router = useRouter();
  const [jobs, setJobs] = useState<ApprovalJob[]>([]);
  const [variations, setVariations] = useState<PendingVariation[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    // Mirrors the web Approvals queue exactly: completed jobs awaiting admin
    // review, plus variations pending approval. (This is distinct from the
    // Invoices "ready to invoice" queue keyed off ready_to_invoice.)
    const [jobsRes, varsRes] = await Promise.all([
      supabase
        .from("jobs")
        .select("id, job_number, title, status, updated_at, customers(name)")
        .eq("status", "completed")
        .eq("admin_status", "pending")
        .order("updated_at", { ascending: false }),
      supabase
        .from("job_variations")
        .select("id, variation_types(name), jobs(id, job_number, title, customers(name))")
        .eq("status", "pending_approval")
        .order("created_at", { ascending: false }),
    ]);
    setJobs((jobsRes.data as unknown as ApprovalJob[]) ?? []);
    setVariations((varsRes.data as unknown as PendingVariation[]) ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const nothing = jobs.length === 0 && variations.length === 0;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.h1}>Approvals</Text>
        <Text style={styles.sub}>Completed jobs & variations awaiting review</Text>
      </View>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.blue600} />}
      >
        {nothing ? (
          <View style={styles.empty}>
            <Ionicons name="checkmark-done-outline" size={34} color={colors.slate400} />
            <Text style={styles.emptyText}>Nothing awaiting approval.</Text>
          </View>
        ) : (
          <>
            {jobs.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Jobs awaiting approval ({jobs.length})</Text>
                <View style={styles.card}>
                  {jobs.map((item) => (
                    <JobListRow
                      key={item.id}
                      jobNumber={item.job_number}
                      title={item.title}
                      subtitle={`${item.customers?.name ?? "—"}${item.updated_at ? ` · ${new Date(item.updated_at).toLocaleDateString("en-AU")}` : ""}`}
                      status={item.status}
                      onPress={() => router.push(`/job/${item.id}`)}
                    />
                  ))}
                </View>
              </View>
            )}

            {variations.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Pending variations ({variations.length})</Text>
                <View style={styles.card}>
                  {variations.map((v, i) => (
                    <TouchableOpacity
                      key={v.id}
                      style={[styles.varRow, i > 0 && styles.varBorder]}
                      onPress={() => v.jobs?.id && router.push(`/job/${v.jobs.id}`)}
                      disabled={!v.jobs?.id}
                    >
                      <Ionicons name="git-pull-request-outline" size={18} color={colors.slate500} />
                      <View style={styles.varBody}>
                        <Text style={styles.varName} numberOfLines={1}>{v.variation_types?.name ?? "Variation"}</Text>
                        <Text style={styles.varJob} numberOfLines={1}>
                          {v.jobs ? `#${v.jobs.job_number} — ${v.jobs.title}` : "—"}
                          {v.jobs?.customers?.name ? ` · ${v.jobs.customers.name}` : ""}
                        </Text>
                      </View>
                      <Ionicons name="chevron-forward" size={16} color={colors.slate400} />
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 10 },
  h1: { fontSize: 22, fontWeight: "800", color: colors.slate900 },
  sub: { fontSize: 13, color: colors.slate500, marginTop: 2 },
  content: { padding: 12, gap: 18, paddingBottom: 40 },
  section: { gap: 8 },
  sectionTitle: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginLeft: 4 },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 12, overflow: "hidden" },
  empty: { alignItems: "center", justifyContent: "center", paddingVertical: 60, gap: 10 },
  emptyText: { fontSize: 13, color: colors.slate400 },
  varRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 14 },
  varBorder: { borderTopWidth: 1, borderTopColor: colors.border },
  varBody: { flex: 1, minWidth: 0 },
  varName: { fontSize: 14, fontWeight: "600", color: colors.slate900 },
  varJob: { fontSize: 12, color: colors.slate500, marginTop: 2 },
});
