import { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, RefreshControl } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../../lib/theme";
import { MoneyText } from "../../../design/components/MoneyText";
import { getJobProfitability, type JobProfitabilityData } from "../../../lib/data/reads/jobCosting";

function pct(v: number | null): string {
  return v === null ? "—" : `${v.toFixed(1)}%`;
}

export default function JobCostingScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [data, setData] = useState<JobProfitabilityData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => { setData(await getJobProfitability(id)); setLoading(false); }, [id]);
  useEffect(() => { load(); }, [load]);
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  if (loading) return <View style={styles.center}><Stack.Screen options={{ title: "Costing" }} /><ActivityIndicator size="large" color={colors.blue600} /></View>;
  if (!data) return <View style={styles.center}><Stack.Screen options={{ title: "Costing" }} /><Text style={styles.muted}>Job not found.</Text></View>;

  const marginPositive = data.margin >= 0;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.blue600} />}>
      <Stack.Screen options={{ title: data.jobNumber ? `#${data.jobNumber} Costing` : "Costing" }} />

      <Text style={styles.section}>True job cost</Text>
      <View style={styles.card}>
        <CostRow label="Labour" detail={`${data.labourHours.toFixed(1)}h logged`} amount={data.labourCost} />
        <CostRow label="Materials / expenses" detail={`${data.expenseCount} expense${data.expenseCount === 1 ? "" : "s"}`} amount={data.materialsCost} />
        <CostRow label="Equipment" detail={`${data.equipmentUsageCount} usage entr${data.equipmentUsageCount === 1 ? "y" : "ies"}`} amount={data.equipmentCost} />
        <View style={[styles.row, styles.totalRow]}>
          <Text style={styles.totalLabel}>Total cost</Text>
          <MoneyText amount={data.totalCost} style={styles.totalValue} />
        </View>
      </View>
      {data.uncostedHours > 0 && (
        <View style={styles.warn}>
          <Ionicons name="warning-outline" size={15} color={colors.orange700} />
          <Text style={styles.warnText}>
            {data.uncostedHours.toFixed(1)}h from {data.uncostedStaffCount} staff member{data.uncostedStaffCount === 1 ? "" : "s"} with no wage on file aren&apos;t costed — the margin is overstated.
          </Text>
        </View>
      )}

      <Text style={styles.section}>Margin vs invoiced</Text>
      <View style={styles.card}>
        <CostRow label="Invoiced (ex GST)" amount={data.revenue} />
        <View style={[styles.row, styles.totalRow]}>
          <Text style={styles.totalLabel}>Margin</Text>
          <View style={styles.marginWrap}>
            <MoneyText amount={data.margin} style={[styles.totalValue, { color: marginPositive ? colors.green600 : colors.red600 }]} />
            <Text style={[styles.marginPct, { color: marginPositive ? colors.green600 : colors.red600 }]}>{pct(data.marginPct)}</Text>
          </View>
        </View>
      </View>

      <Text style={styles.section}>Projected (before invoicing)</Text>
      <View style={styles.card}>
        <CostRow label="Projected revenue" detail="built-up items + unbilled variations" amount={data.projectedRevenue} />
        <View style={[styles.row, styles.totalRow]}>
          <Text style={styles.totalLabel}>Projected margin</Text>
          <View style={styles.marginWrap}>
            <MoneyText amount={data.projectedMargin} style={[styles.totalValue, { color: data.projectedMargin >= 0 ? colors.green600 : colors.red600 }]} />
            <Text style={[styles.marginPct, { color: data.projectedMargin >= 0 ? colors.green600 : colors.red600 }]}>{pct(data.projectedMarginPct)}</Text>
          </View>
        </View>
      </View>
      {data.belowMinMargin && (
        <View style={styles.warn}>
          <Ionicons name="alert-circle-outline" size={15} color={colors.red600} />
          <Text style={[styles.warnText, { color: colors.red600 }]}>Below your {data.minMarginPct.toFixed(0)}% minimum margin.</Text>
        </View>
      )}

      <Text style={styles.footnote}>Labour is costed at each staff member&apos;s fully-loaded rate (payroll on-costs + assigned-vehicle running cost). Admin-only.</Text>
    </ScrollView>
  );
}

function CostRow({ label, detail, amount }: { label: string; detail?: string; amount: number }) {
  return (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowLabel}>{label}</Text>
        {detail ? <Text style={styles.rowDetail}>{detail}</Text> : null}
      </View>
      <MoneyText amount={amount} style={styles.rowValue} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 40 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  muted: { fontSize: 13, color: colors.slate500 },
  section: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginTop: 16, marginBottom: 8, marginLeft: 4 },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8 },
  rowLabel: { fontSize: 14, fontWeight: "600", color: colors.slate900 },
  rowDetail: { fontSize: 12, color: colors.slate400, marginTop: 1 },
  rowValue: { fontSize: 14, fontWeight: "600", color: colors.slate700 },
  totalRow: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: 4, paddingTop: 12 },
  totalLabel: { flex: 1, fontSize: 14, fontWeight: "800", color: colors.slate900 },
  totalValue: { fontSize: 16, fontWeight: "800", color: colors.slate900 },
  marginWrap: { alignItems: "flex-end" },
  marginPct: { fontSize: 12, fontWeight: "700", marginTop: 1 },
  warn: { flexDirection: "row", gap: 8, alignItems: "flex-start", backgroundColor: colors.orange100, borderRadius: 10, padding: 10, marginTop: 8 },
  warnText: { flex: 1, fontSize: 12, color: colors.orange700, lineHeight: 16 },
  footnote: { fontSize: 11, color: colors.slate400, textAlign: "center", marginTop: 18, lineHeight: 15 },
});
