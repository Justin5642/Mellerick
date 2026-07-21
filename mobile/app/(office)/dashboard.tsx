import { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { supabase } from "../../lib/supabase";
import { colors } from "../../lib/theme";
import { useAuth } from "../../lib/auth-context";
import { computeNextDueDate, getDueStatus } from "../../lib/backflow";
import { isTodayInBusinessTZ, formatBusinessTime, businessHour } from "../../lib/date";
import { StatCard } from "../../design/components/StatCard";
import { JobListRow } from "../../design/components/JobListRow";

interface DashJob {
  id: string;
  job_number: number;
  title: string;
  status: string;
  priority: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  customers: { name: string } | null;
  profiles?: { full_name: string } | null;
  assigned_profile?: { full_name: string } | null;
}
interface DashDevice {
  test_frequency_months: number;
  backflow_tests: { test_date: string; result: string }[] | null;
}
interface Counts {
  total: number;
  active: number;
  customers: number;
  overdue: number;
  backflowDue: number;
}

export default function DashboardScreen() {
  const router = useRouter();
  const { profile } = useAuth();
  const [counts, setCounts] = useState<Counts>({ total: 0, active: 0, customers: 0, overdue: 0, backflowDue: 0 });
  const [recent, setRecent] = useState<DashJob[]>([]);
  const [today, setToday] = useState<DashJob[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [totalRes, activeRes, custRes, overdueRes, recentRes, scheduledRes, devicesRes] = await Promise.all([
      supabase.from("jobs").select("*", { count: "exact", head: true }),
      supabase.from("jobs").select("*", { count: "exact", head: true }).in("status", ["pending", "scheduled", "in_progress"]),
      supabase.from("customers").select("*", { count: "exact", head: true }).eq("is_active", true),
      supabase.from("invoices").select("*", { count: "exact", head: true }).eq("status", "overdue"),
      supabase
        .from("jobs")
        // jobs has multiple FKs to profiles — the FK hint + alias are required.
        .select("*, customers(name), assigned_profile:profiles!jobs_assigned_to_fkey(full_name)")
        .order("created_at", { ascending: false })
        .limit(8),
      supabase
        .from("jobs")
        .select("*, customers(name), profiles!jobs_assigned_to_fkey(full_name)")
        .not("scheduled_start", "is", null)
        .not("status", "in", '("completed","cancelled")')
        .order("scheduled_start"),
      supabase.from("backflow_devices").select("test_frequency_months, backflow_tests(test_date, result)").eq("is_active", true),
    ]);

    const devices = (devicesRes.data as unknown as DashDevice[]) ?? [];
    const backflowDue = devices.filter((device) => {
      const passing = (device.backflow_tests ?? []).filter((t) => t.result === "pass");
      const lastPass = passing.sort((a, b) => (a.test_date < b.test_date ? 1 : -1))[0];
      const next = computeNextDueDate(lastPass?.test_date, Number(device.test_frequency_months));
      const status = getDueStatus(next);
      return status === "overdue" || status === "due_soon";
    }).length;

    setCounts({
      total: totalRes.count ?? 0,
      active: activeRes.count ?? 0,
      customers: custRes.count ?? 0,
      overdue: overdueRes.count ?? 0,
      backflowDue,
    });
    setRecent((recentRes.data as unknown as DashJob[]) ?? []);
    const scheduled = (scheduledRes.data as unknown as DashJob[]) ?? [];
    setToday(scheduled.filter((j) => j.scheduled_start != null && isTodayInBusinessTZ(j.scheduled_start)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const hour = businessHour();
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const firstName = profile?.full_name?.split(" ")[0] ?? "there";
  const dateLabel = new Date().toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.blue600} />}
      >
        <View style={styles.header}>
          <Text style={styles.greeting}>{greeting}, {firstName}</Text>
          <Text style={styles.date}>{dateLabel}</Text>
        </View>

        <View style={styles.grid}>
          <StatCard title="Active Jobs" value={counts.active} icon="briefcase" iconColor="#3b82f6" onPress={() => router.push("/jobs")} />
          <StatCard title="Total Jobs" value={counts.total} icon="checkmark-circle" iconColor="#22c55e" onPress={() => router.push("/jobs")} />
          <StatCard title="Customers" value={counts.customers} icon="people" iconColor="#8b5cf6" onPress={() => router.push("/customers")} />
          <StatCard title="Overdue Invoices" value={counts.overdue} icon="alert-circle" iconColor="#ef4444" onPress={() => router.push("/invoices")} />
          <StatCard title="Backflow Due" value={counts.backflowDue} icon="water" iconColor="#0891b2" />
        </View>

        <Section title="Today's Jobs" action="View schedule" onAction={() => router.push("/schedule")}>
          {today.length === 0 ? (
            <Empty icon="time-outline" text="No jobs scheduled for today." />
          ) : (
            today.map((job) => (
              <JobListRow
                key={job.id}
                jobNumber={job.job_number}
                title={job.title}
                subtitle={`${job.customers?.name ?? "—"}${job.profiles?.full_name ? ` · ${job.profiles.full_name}` : " · Unassigned"}`}
                status={job.status}
                leading={
                  <View style={styles.timeCol}>
                    <Text style={styles.timeStart}>{job.scheduled_start ? formatBusinessTime(job.scheduled_start) : ""}</Text>
                    {job.scheduled_end ? <Text style={styles.timeEnd}>{formatBusinessTime(job.scheduled_end)}</Text> : null}
                  </View>
                }
                onPress={() => router.push(`/job/${job.id}`)}
              />
            ))
          )}
        </Section>

        <Section title="Recent Jobs" action="View all" onAction={() => router.push("/jobs")}>
          {recent.length === 0 ? (
            <Empty icon="briefcase-outline" text="No jobs yet." />
          ) : (
            recent.map((job) => (
              <JobListRow
                key={job.id}
                jobNumber={job.job_number}
                title={job.title}
                subtitle={`${job.customers?.name ?? "—"}${job.assigned_profile?.full_name ? ` · ${job.assigned_profile.full_name}` : ""}`}
                status={job.status}
                priority={job.priority}
                onPress={() => router.push(`/job/${job.id}`)}
              />
            ))
          )}
        </Section>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ title, action, onAction, children }: { title: string; action?: string; onAction?: () => void; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {action ? <Text style={styles.sectionAction} onPress={onAction}>{action}</Text> : null}
      </View>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function Empty({ icon, text }: { icon: keyof typeof Ionicons.glyphMap; text: string }) {
  return (
    <View style={styles.empty}>
      <Ionicons name={icon} size={34} color={colors.slate400} />
      <Text style={styles.emptyText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingTop: 8, gap: 18, paddingBottom: 40 },
  header: { marginTop: 4 },
  greeting: { fontSize: 22, fontWeight: "800", color: colors.slate900 },
  date: { fontSize: 13, color: colors.slate500, marginTop: 2 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  section: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 14, overflow: "hidden" },
  sectionHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", padding: 16, paddingBottom: 10 },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: colors.slate900 },
  sectionAction: { fontSize: 13, color: colors.blue600, fontWeight: "600" },
  sectionBody: {},
  empty: { alignItems: "center", justifyContent: "center", paddingVertical: 34, gap: 10 },
  emptyText: { fontSize: 13, color: colors.slate400 },
  timeCol: { width: 52, alignItems: "center" },
  timeStart: { fontSize: 12, fontWeight: "700", color: colors.blue600 },
  timeEnd: { fontSize: 11, color: colors.slate400 },
});
