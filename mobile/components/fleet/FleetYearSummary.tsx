import { useMemo, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { colors } from "../../lib/theme";
import { MoneyText } from "../../design/components/MoneyText";
import { RoleGate } from "../../design/guards/RoleGate";
import { dateKeyInBusinessTZ } from "../../lib/date";
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  financialYearsSince,
  summariseExpenses,
  type FleetExpense,
} from "../../lib/fleetCosts";

// Fleet → "Fleet costs logged — FY …" (the web's components/fleet/
// fleet-year-summary.tsx): the whole fleet's logged cost for one financial
// year, ex GST, by category. Office/admin only — every figure is money.
export function FleetYearSummary({ expenses }: { expenses: FleetExpense[] }) {
  const today = dateKeyInBusinessTZ(new Date());
  const years = useMemo(() => financialYearsSince(expenses.map((e) => e.expense_date), today), [expenses, today]);
  const [label, setLabel] = useState(years[0].label);
  const period = years.find((y) => y.label === label) ?? years[0];
  const s = useMemo(() => summariseExpenses(expenses, period), [expenses, period]);

  return (
    <RoleGate roles={["office", "admin"]}>
      <View style={styles.card}>
        <Text style={styles.title}>Fleet costs logged — {period.label}</Text>
        <YearPicker years={years.map((y) => y.label)} value={period.label} onChange={setLabel} />
        <View style={styles.grid}>
          <View style={styles.cell}>
            <Text style={styles.label}>Total (ex GST)</Text>
            <MoneyText amount={s.totalExGst} style={styles.total} />
          </View>
          {EXPENSE_CATEGORIES.filter((c) => s.byCategory[c]).map((c) => (
            <View key={c} style={styles.cell}>
              <Text style={styles.label}>{EXPENSE_CATEGORY_LABELS[c]}</Text>
              <MoneyText amount={s.byCategory[c]?.exGst ?? 0} style={styles.value} />
            </View>
          ))}
        </View>
      </View>
    </RoleGate>
  );
}

/** Financial-year chips, newest first. */
export function YearPicker({ years, value, onChange }: { years: string[]; value: string; onChange: (label: string) => void }) {
  if (years.length < 2) return null;
  return (
    <View style={styles.chips}>
      {years.map((y) => (
        <TouchableOpacity key={y} style={[styles.chip, y === value && styles.chipActive]} onPress={() => onChange(y)} accessibilityLabel={`Show ${y}`}>
          <Text style={[styles.chipText, y === value && styles.chipTextActive]}>{y}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12, marginHorizontal: 16, marginTop: 12 },
  title: { fontSize: 13, fontWeight: "700", color: colors.slate700 },
  grid: { flexDirection: "row", flexWrap: "wrap", marginTop: 8 },
  cell: { width: "33%", paddingVertical: 4 },
  label: { fontSize: 11, color: colors.slate500 },
  total: { fontSize: 15, fontWeight: "800", color: colors.slate900 },
  value: { fontSize: 13, fontWeight: "600", color: colors.slate700 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 },
  chip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  chipActive: { backgroundColor: colors.blue600, borderColor: colors.blue600 },
  chipText: { fontSize: 11, fontWeight: "600", color: colors.slate700 },
  chipTextActive: { color: "#fff" },
});
