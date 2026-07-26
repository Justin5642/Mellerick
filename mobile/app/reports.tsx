import { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, RefreshControl, ActivityIndicator } from "react-native";
import { Stack } from "expo-router";
import { colors, statusColors } from "../lib/theme";
import { MoneyText } from "../design/components/MoneyText";
import { StatCard } from "../design/components/StatCard";
import { getReportSummary, type ReportSummary } from "../lib/data/reads/reports";

function humanize(v: string): string {
  return v.replace(/_/g, " ");
}

export default function ReportsScreen() {
  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => setSummary(await getReportSummary()), []);
  useEffect(() => { load(); }, [load]);
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  const jobsTotal = summary ? summary.jobsByStatus.reduce((s, j) => s + j.count, 0) : 0;
  const acceptRate = summary && summary.quotesTotal > 0 ? Math.round((summary.quotesAccepted / summary.quotesTotal) * 100) : 0;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.blue600} />}>
      <Stack.Screen options={{ title: "Reports" }} />

      {!summary ? (
        <ActivityIndicator color={colors.blue600} style={{ marginTop: 30 }} />
      ) : (
        <>
          <Text style={styles.section}>Revenue</Text>
          <View style={styles.row}>
            <MoneyCard title="Paid" amount={summary.revenuePaid} color="#22c55e" />
            <MoneyCard title="Outstanding" amount={summary.outstanding} color="#f59e0b" />
          </View>

          <Text style={styles.section}>Pipeline</Text>
          <View style={styles.row}>
            <StatCard title="Active Jobs" value={summary.activeJobs} icon="briefcase" iconColor="#3b82f6" />
            <StatCard title="Quote win rate" value={`${acceptRate}%`} icon="trophy" iconColor="#8b5cf6" />
          </View>

          <Text style={styles.section}>Jobs by status</Text>
          <View style={styles.card}>
            {summary.jobsByStatus.map((j) => {
              const pct = jobsTotal > 0 ? (j.count / jobsTotal) * 100 : 0;
              const sc = statusColors[j.status] ?? { bg: colors.slate100, text: colors.slate500 };
              return (
                <View key={j.status} style={styles.barRow}>
                  <Text style={styles.barLabel}>{humanize(j.status)}</Text>
                  <View style={styles.barTrack}>
                    <View style={[styles.barFill, { width: `${Math.max(pct, 2)}%`, backgroundColor: sc.text }]} />
                  </View>
                  <Text style={styles.barCount}>{j.count}</Text>
                </View>
              );
            })}
          </View>

          <Text style={styles.footnote}>Detailed charts (revenue trend, payroll cost) are available on the web dashboard.</Text>
        </>
      )}
    </ScrollView>
  );
}

function MoneyCard({ title, amount, color }: { title: string; amount: number; color: string }) {
  return (
    <View style={styles.moneyCard}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={styles.moneyTitle}>{title}</Text>
      <MoneyText amount={amount} style={styles.moneyValue} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 40, gap: 6 },
  section: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginTop: 14, marginBottom: 8, marginLeft: 4 },
  row: { flexDirection: "row", gap: 10 },
  moneyCard: { flex: 1, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 14, padding: 16 },
  dot: { width: 10, height: 10, borderRadius: 5, marginBottom: 8 },
  moneyTitle: { fontSize: 12, color: colors.slate500 },
  moneyValue: { fontSize: 20, fontWeight: "800", color: colors.slate900, marginTop: 2 },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 14, padding: 14, gap: 10 },
  barRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  barLabel: { width: 90, fontSize: 12, color: colors.slate500, textTransform: "capitalize" },
  barTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: colors.slate100, overflow: "hidden" },
  barFill: { height: 8, borderRadius: 4 },
  barCount: { width: 32, textAlign: "right", fontSize: 13, fontWeight: "700", color: colors.slate900 },
  footnote: { fontSize: 11, color: colors.slate400, textAlign: "center", marginTop: 14 },
});
