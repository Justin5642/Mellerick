import { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, RefreshControl, TouchableOpacity } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { colors } from "../../lib/theme";
import { useAuth } from "../../lib/auth-context";
import { isTodayInBusinessTZ, formatBusinessTime, businessHour } from "../../lib/date";
import { StatCard } from "../../design/components/StatCard";
import { JobListRow } from "../../design/components/JobListRow";
import { ScreenError } from "../../design/components/ScreenError";
import { getOfficeDashboard, type DashboardJob } from "../../lib/data/reads/dashboard";
import { listBackflowDevices } from "../../lib/data/reads/backflow";

type DashJob = DashboardJob;
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
  const [error, setError] = useState<unknown>(null);

  // Every read here is unwrapped rather than defaulted, because a dashboard is
  // read as a statement of fact. A count that fails and renders "0" under
  // "Overdue Invoices", or a list that fails and renders "No jobs scheduled for
  // today", is not a gap the reader notices — it is a number they believe and
  // act on. The screen fails as a whole because these arrive in one Promise.all:
  // one honest error is worth more than five figures with a lie among them.
  const load = useCallback(async () => {
    try {
      setError(null);
      // Local-first (lib/data/reads/dashboard + reads/backflow): the office
      // mirror carries every table these figures are computed from, so the
      // dashboard opens without SEVEN network round-trips — the last of which
      // used to download every active backflow device with its full test
      // history just to count the ones falling due.
      const [dash, backflowRows] = await Promise.all([getOfficeDashboard(), listBackflowDevices()]);
      const backflowDue = backflowRows.filter((r) => r.status === "overdue" || r.status === "due_soon").length;

      setCounts({ ...dash.counts, backflowDue });
      setRecent(dash.recent);
      setToday(dash.scheduled.filter((j) => j.scheduled_start != null && isTodayInBusinessTZ(j.scheduled_start)));
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    void load();
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

  // Checked before the grid and both lists, so a failed load is never dressed up
  // as a quiet day: zeroed stat cards and "No jobs scheduled for today" are the
  // shapes this screen would otherwise take on failure, and both read as facts.
  if (error) {
    return (
      <SafeAreaView style={styles.safe} edges={["top"]}>
        <ScreenError error={error} onRetry={() => { void load(); }} />
      </SafeAreaView>
    );
  }

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
          <StatCard title="Backflow Due" value={counts.backflowDue} icon="water" iconColor="#0891b2" onPress={() => router.push("/backflow/list")} />
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
                subtitle={`${job.customers?.name ?? "—"}${job.assigned_profile?.full_name ? ` · ${job.assigned_profile.full_name}` : " · Unassigned"}`}
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
            <TouchableOpacity onPress={() => router.push("/jobs/new")} style={styles.empty}>
              <Ionicons name="add-circle-outline" size={28} color={colors.blue600} />
              <Text style={[styles.emptyText, { color: colors.blue600, fontWeight: "600" }]}>Create your first job</Text>
            </TouchableOpacity>
          ) : (
            recent.map((job) => (
              <JobListRow
                key={job.id}
                jobNumber={job.job_number}
                title={job.title}
                subtitle={`${job.customers?.name ?? "—"}${job.assigned_profile?.full_name ? ` · ${job.assigned_profile.full_name}` : ""}`}
                status={job.status}
                priority={job.priority ?? undefined}
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
