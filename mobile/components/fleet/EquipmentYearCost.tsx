import { useMemo, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { colors } from "../../lib/theme";
import { MoneyText } from "../../design/components/MoneyText";
import { RoleGate } from "../../design/guards/RoleGate";
import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS, financialYearsSince, summariseExpenses, type FleetExpense } from "../../lib/fleetCosts";
import { YearPicker } from "./FleetYearSummary";

const monthLetter = (ym: string) =>
  new Date(`${ym}-01T00:00:00Z`).toLocaleString("en-AU", { month: "short", timeZone: "UTC" }).slice(0, 1);

/**
 * One machine's logged costs for a financial year (1 Jul – 30 Jun), by
 * category and by month, against its estimated annual cost and the hours
 * logged — the web's components/fleet/equipment-year-cost.tsx. Office/admin
 * only (every figure is money).
 */
export function EquipmentYearCost({
  expenses,
  usage,
  today,
  estimatedAnnualCost,
}: {
  expenses: FleetExpense[];
  usage: { usage_date: string; hours: number | string }[];
  today: string;
  estimatedAnnualCost: number;
}) {
  const years = useMemo(() => financialYearsSince(expenses.map((e) => e.expense_date), today), [expenses, today]);
  const [label, setLabel] = useState(years[0].label);
  const period = years.find((y) => y.label === label) ?? years[0];
  const summary = useMemo(() => summariseExpenses(expenses, period), [expenses, period]);
  const hours = usage
    .filter((u) => u.usage_date >= period.start && u.usage_date <= period.end)
    .reduce((s, u) => s + (Number(u.hours) || 0), 0);
  const peak = Math.max(1, ...summary.byMonth.map((m) => m.exGst));
  const isCurrent = period === years[0];
  const overEstimate = estimatedAnnualCost > 0 && summary.totalExGst > estimatedAnnualCost;

  return (
    <RoleGate roles={["office", "admin"]}>
      <Text style={styles.section}>Costs logged — {period.label}</Text>
      <View style={styles.card}>
        <YearPicker years={years.map((y) => y.label)} value={period.label} onChange={setLabel} />
        <View style={styles.stats}>
          <View style={styles.stat}><Text style={styles.statLabel}>{isCurrent ? "Spent so far (ex GST)" : "Spent (ex GST)"}</Text><MoneyText amount={summary.totalExGst} style={styles.statValue} /></View>
          <View style={styles.stat}><Text style={styles.statLabel}>GST</Text><MoneyText amount={summary.totalGst} style={styles.statValue} /></View>
          <View style={styles.stat}><Text style={styles.statLabel}>Expenses</Text><Text style={styles.statValue}>{summary.count}</Text></View>
          <View style={styles.stat}><Text style={styles.statLabel}>Hours logged</Text><Text style={styles.statValue}>{hours.toFixed(1)}h</Text></View>
        </View>
        {summary.count === 0 ? (
          <Text style={styles.empty}>No expenses logged for {period.label}.</Text>
        ) : (
          <>
            {EXPENSE_CATEGORIES.filter((c) => summary.byCategory[c]).map((c) => {
              const row = summary.byCategory[c];
              return (
                <View key={c} style={styles.catRow}>
                  <Text style={styles.catLabel}>{EXPENSE_CATEGORY_LABELS[c]} · {row.count}</Text>
                  <MoneyText amount={row.exGst} style={styles.catValue} />
                </View>
              );
            })}
            <View style={styles.bars} accessibilityLabel={`Monthly costs for ${period.label}`}>
              {summary.byMonth.map((m) => (
                <View key={m.month} style={styles.barCol}>
                  <View style={[styles.bar, { height: `${Math.max(m.exGst > 0 ? 4 : 0, (m.exGst / peak) * 100)}%` }]} />
                  <Text style={styles.barLabel}>{monthLetter(m.month)}</Text>
                </View>
              ))}
            </View>
          </>
        )}
        {estimatedAnnualCost > 0 && (
          <Text style={[styles.note, overEstimate && styles.noteWarn]}>
            Estimated annual running cost from the cost profile: <MoneyText amount={estimatedAnnualCost} style={styles.note} /> (includes depreciation, which isn&apos;t a logged expense).
            {overEstimate ? " Logged costs are already above it." : ""}
          </Text>
        )}
      </View>
    </RoleGate>
  );
}

const styles = StyleSheet.create({
  section: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginTop: 16, marginBottom: 8, marginLeft: 4 },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12 },
  stats: { flexDirection: "row", flexWrap: "wrap", marginTop: 8 },
  stat: { width: "50%", paddingVertical: 4 },
  statLabel: { fontSize: 11, color: colors.slate500 },
  statValue: { fontSize: 15, fontWeight: "700", color: colors.slate900 },
  empty: { fontSize: 13, color: colors.slate400, paddingVertical: 8 },
  catRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 5, borderTopWidth: 1, borderTopColor: colors.slate100 },
  catLabel: { fontSize: 13, color: colors.slate700 },
  catValue: { fontSize: 13, fontWeight: "600", color: colors.slate900 },
  bars: { flexDirection: "row", alignItems: "flex-end", height: 72, gap: 3, marginTop: 10 },
  barCol: { flex: 1, height: "100%", justifyContent: "flex-end", alignItems: "center" },
  bar: { width: "100%", borderRadius: 2, backgroundColor: colors.blue600 },
  barLabel: { fontSize: 9, color: colors.slate400, marginTop: 2 },
  note: { fontSize: 11, color: colors.slate500, marginTop: 10 },
  noteWarn: { color: colors.orange700 },
});
