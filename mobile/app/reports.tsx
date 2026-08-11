import { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, RefreshControl, ActivityIndicator } from "react-native";
import { Stack } from "expo-router";
import { colors, statusColors } from "../lib/theme";
import { MoneyText } from "../design/components/MoneyText";
import { StatCard } from "../design/components/StatCard";
import { getReportSummary, getReportAnalytics, getStaffEfficiency, getEquipmentUtilization, type ReportSummary, type ReportAnalytics } from "../lib/data/reads/reports";
import { ScreenError } from "../design/components/ScreenError";
import { type StaffEffRow } from "../lib/staffEfficiency";
import { type EquipUtilRow } from "../lib/equipmentUtilization";
import { useIsAdmin } from "../design/guards/useRole";

function humanize(v: string): string {
  return v.replace(/_/g, " ");
}
function monthLabel(monthKey: string): string {
  return new Date(`${monthKey}-01T00:00:00`).toLocaleDateString("en-AU", { month: "short" });
}

export default function ReportsScreen() {
  const isAdmin = useIsAdmin();
  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [analytics, setAnalytics] = useState<ReportAnalytics | null>(null);
  const [staffEff, setStaffEff] = useState<StaffEffRow[] | null>(null);
  const [equipUtil, setEquipUtil] = useState<EquipUtilRow[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // These four reads now THROW on a failed query instead of returning empty.
  // "Loading" on this screen is `summary === null`, so an uncaught throw would
  // leave that null forever — a permanent spinner over the money figures, which
  // tells the reader even less than a wrong zero did. The finally also clears
  // `refreshing`, or a failed pull-to-refresh leaves the spinner stuck at the top.
  const load = useCallback(async () => {
    try {
      setError(null);
      const [s, a, eq] = await Promise.all([getReportSummary(), getReportAnalytics(), getEquipmentUtilization()]);
      setSummary(s);
      setAnalytics(a);
      setEquipUtil(eq);
      if (isAdmin) setStaffEff(await getStaffEfficiency());
    } catch (e) {
      setError(e);
    } finally {
      setRefreshing(false);
    }
  }, [isAdmin]);
  useEffect(() => { void load(); }, [load]);
  const onRefresh = useCallback(() => { setRefreshing(true); void load(); }, [load]);

  const jobsTotal = summary ? summary.jobsByStatus.reduce((s, j) => s + j.count, 0) : 0;
  // Win rate = accepted / (accepted + declined), matching the web (decided
  // quotes only, not drafts/sent/expired).
  const decided = summary ? summary.quotesAccepted + summary.quotesDeclined : 0;
  const acceptRate = decided > 0 ? Math.round((summary!.quotesAccepted / decided) * 100) : 0;

  // Checked BEFORE the report renders, so a failed load can never fall through
  // to a page of zeroes. A revenue figure that reads $0 because the query broke
  // is worse than no figure at all. Retry drops back to the spinner by clearing
  // `summary`, this screen's loading flag.
  if (error) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: "Reports" }} />
        <ScreenError
          error={error}
          onRetry={() => {
            setSummary(null);
            void load();
          }}
        />
      </View>
    );
  }

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
          <View style={styles.row}>
            <MoneyCard title="Overdue" amount={summary.totalOverdue} color="#ef4444" />
            <MoneyCard title="Accepted quotes" amount={summary.acceptedValue} color="#3b82f6" />
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

          {/* Quote pipeline by status — the web reports dashboard's quote
              breakdown (draft/sent/accepted/declined/expired). */}
          <Text style={styles.section}>Quotes by status</Text>
          <View style={styles.card}>
            {summary.quotesByStatus.map((q) => {
              const pct = summary.quotesTotal > 0 ? (q.count / summary.quotesTotal) * 100 : 0;
              const sc = statusColors[q.status] ?? { bg: colors.slate100, text: colors.slate500 };
              return (
                <View key={q.status} style={styles.barRow}>
                  <Text style={styles.barLabel}>{humanize(q.status)}</Text>
                  <View style={styles.barTrack}>
                    <View style={[styles.barFill, { width: `${Math.max(pct, 2)}%`, backgroundColor: sc.text }]} />
                  </View>
                  <Text style={styles.barCount}>{q.count}</Text>
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

          {isAdmin && staffEff && staffEff.length > 0 && (
            <>
              <Text style={styles.section}>Staff cost &amp; efficiency</Text>
              <Text style={styles.sectionNote}>Last 12 months · true cost = fully-loaded annual cost ÷ hours worked</Text>
              <View style={styles.card}>
                {staffEff.map((s) => (
                  <View key={s.name} style={styles.staffRow}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.staffName} numberOfLines={1}>{s.name}</Text>
                      <Text style={styles.staffSub}>
                        {s.workedHours.toFixed(0)}h worked · {s.leaveHours.toFixed(0)}h leave
                        {s.utilizationPct != null ? ` · ${Math.round(s.utilizationPct)}% util` : ""}
                      </Text>
                    </View>
                    <View style={{ alignItems: "flex-end" }}>
                      {s.trueCostPerWorkedHour != null ? (
                        <MoneyText amount={s.trueCostPerWorkedHour} style={styles.staffCost} />
                      ) : (
                        <Text style={styles.staffCostMuted}>—</Text>
                      )}
                      <View style={styles.rateRow}>
                        <Text style={styles.staffRate}>loaded </Text>
                        <MoneyText amount={s.loadedHourlyRate} style={styles.staffRate} />
                        <Text style={styles.staffRate}>/h</Text>
                      </View>
                    </View>
                  </View>
                ))}
              </View>
            </>
          )}

          {equipUtil && equipUtil.length > 0 && (
            <>
              <Text style={styles.section}>Equipment cost &amp; utilisation</Text>
              <Text style={styles.sectionNote}>Last 12 months · true cost = fixed annual cost ÷ hours used + fuel</Text>
              <View style={styles.card}>
                {equipUtil.map((e) => (
                  <View key={e.name} style={styles.staffRow}>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={styles.staffName} numberOfLines={1}>{e.name}</Text>
                      <Text style={styles.staffSub}>
                        {e.hoursUsed.toFixed(0)}h used
                        {e.utilizationPct != null ? ` · ${Math.round(e.utilizationPct)}% util` : ""}
                      </Text>
                    </View>
                    <View style={{ alignItems: "flex-end" }}>
                      {e.trueCostPerHourUsed != null ? (
                        <MoneyText amount={e.trueCostPerHourUsed} style={styles.staffCost} />
                      ) : (
                        <Text style={styles.staffCostMuted}>—</Text>
                      )}
                      <View style={styles.rateRow}>
                        <Text style={styles.staffRate}>budget </Text>
                        <MoneyText amount={e.budgetedCostPerHour} style={styles.staffRate} />
                        <Text style={styles.staffRate}>/h</Text>
                      </View>
                    </View>
                  </View>
                ))}
              </View>
            </>
          )}

          <Text style={styles.footnote}>Pull to refresh. All figures update live from the database.</Text>
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
  sectionNote: { fontSize: 11, color: colors.slate400, marginLeft: 4, marginTop: -4, marginBottom: 8 },
  staffRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.slate100 },
  staffName: { fontSize: 14, fontWeight: "600", color: colors.slate900 },
  staffSub: { fontSize: 12, color: colors.slate500, marginTop: 1 },
  staffCost: { fontSize: 15, fontWeight: "800", color: colors.slate900 },
  staffCostMuted: { fontSize: 15, fontWeight: "800", color: colors.slate400 },
  rateRow: { flexDirection: "row", alignItems: "center", marginTop: 1 },
  staffRate: { fontSize: 11, color: colors.slate400 },
  footnote: { fontSize: 11, color: colors.slate400, textAlign: "center", marginTop: 14 },
});
