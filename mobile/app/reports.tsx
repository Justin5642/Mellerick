import { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, RefreshControl, ActivityIndicator } from "react-native";
import { Stack } from "expo-router";
import { colors, statusColors } from "../lib/theme";
import { MoneyText } from "../design/components/MoneyText";
import { StatCard } from "../design/components/StatCard";
import { getReportSummary, getReportAnalytics, type ReportSummary, type ReportAnalytics } from "../lib/data/reads/reports";

function humanize(v: string): string {
  return v.replace(/_/g, " ");
}
function monthLabel(monthKey: string): string {
  return new Date(`${monthKey}-01T00:00:00`).toLocaleDateString("en-AU", { month: "short" });
}

export default function ReportsScreen() {
  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [analytics, setAnalytics] = useState<ReportAnalytics | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [s, a] = await Promise.all([getReportSummary(), getReportAnalytics()]);
    setSummary(s);
    setAnalytics(a);
  }, []);
  useEffect(() => { load(); }, [load]);
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  const jobsTotal = summary ? summary.jobsByStatus.reduce((s, j) => s + j.count, 0) : 0;
  // Win rate = accepted / (accepted + declined), matching the web (decided
  // quotes only, not drafts/sent/expired).
  const decided = summary ? summary.quotesAccepted + summary.quotesDeclined : 0;
  const acceptRate = decided > 0 ? Math.round((summary!.quotesAccepted / decided) * 100) : 0;

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

          {analytics && (
            <>
              <Text style={styles.section}>Revenue by month</Text>
              <View style={styles.card}>
                {(() => {
                  const max = Math.max(1, ...analytics.revenueByMonth.map((m) => m.paid + m.outstanding));
                  return analytics.revenueByMonth.map((m) => (
                    <View key={m.monthKey} style={styles.barRow}>
                      <Text style={styles.barLabel}>{monthLabel(m.monthKey)}</Text>
                      <View style={styles.stackTrack}>
                        <View style={{ width: `${(m.paid / max) * 100}%`, backgroundColor: "#22c55e" }} />
                        <View style={{ width: `${(m.outstanding / max) * 100}%`, backgroundColor: "#f59e0b" }} />
                      </View>
                      <MoneyText amount={m.paid + m.outstanding} style={styles.barMoney} />
                    </View>
                  ));
                })()}
                <Text style={styles.legend}>Green = paid · Amber = outstanding</Text>
              </View>

              {analytics.topCustomers.length > 0 && (
                <>
                  <Text style={styles.section}>Top customers by spend</Text>
                  <View style={styles.card}>
                    {analytics.topCustomers.map((c, i) => (
                      <View key={c.customerId} style={styles.listRow}>
                        <Text style={styles.rank}>{i + 1}</Text>
                        <Text style={styles.listName} numberOfLines={1}>{c.name}</Text>
                        <MoneyText amount={c.total} style={styles.listValue} />
                      </View>
                    ))}
                  </View>
                </>
              )}

              {analytics.jobsByStaff.length > 0 && (
                <>
                  <Text style={styles.section}>Jobs by staff</Text>
                  <View style={styles.card}>
                    {analytics.jobsByStaff.map((s) => (
                      <View key={s.name} style={styles.listRow}>
                        <Text style={styles.listName} numberOfLines={1}>{s.name}</Text>
                        <Text style={styles.staffMeta}>{s.completed}/{s.total} done · {Math.round(s.rate)}%</Text>
                      </View>
                    ))}
                  </View>
                </>
              )}
            </>
          )}

          <Text style={styles.footnote}>Staff cost/efficiency + equipment utilization tables are on the web dashboard.</Text>
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
  stackTrack: { flex: 1, height: 10, borderRadius: 5, backgroundColor: colors.slate100, overflow: "hidden", flexDirection: "row" },
  barMoney: { width: 72, textAlign: "right", fontSize: 12, fontWeight: "700", color: colors.slate900 },
  legend: { fontSize: 11, color: colors.slate400, marginTop: 2 },
  listRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.slate100 },
  rank: { width: 18, fontSize: 12, fontWeight: "700", color: colors.slate400 },
  listName: { flex: 1, fontSize: 14, fontWeight: "600", color: colors.slate900 },
  listValue: { fontSize: 14, fontWeight: "700", color: colors.slate900 },
  staffMeta: { fontSize: 13, fontWeight: "600", color: colors.slate500 },
  footnote: { fontSize: 11, color: colors.slate400, textAlign: "center", marginTop: 14 },
});
