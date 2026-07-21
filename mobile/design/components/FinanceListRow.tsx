import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { colors } from "../../lib/theme";
import { MoneyText } from "./MoneyText";
import { StatusPill } from "./StatusPill";
import type { StatusDomain } from "../tokens/status";

export interface FinanceListRowProps {
  number: string; // e.g. INV-0001 / QUO-0007
  title: string;
  subtitle?: string;
  amount: number | null | undefined;
  statusDomain: StatusDomain;
  statusValue: string;
  onPress?: () => void;
}

// One invoice/quote row: "NUM — title", subtitle (customer · due), a role-gated
// money total, and a status pill. Money always renders through MoneyText so a
// technician (should one ever reach a financial screen) sees a redaction.
export function FinanceListRow({ number, title, subtitle, amount, statusDomain, statusValue, onPress }: FinanceListRowProps) {
  return (
    <TouchableOpacity style={styles.row} onPress={onPress} disabled={!onPress} activeOpacity={0.6} testID="finance-list-row">
      <View style={styles.body}>
        <Text style={styles.title} numberOfLines={1}>
          {number} — {title}
        </Text>
        {!!subtitle && <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text>}
      </View>
      <View style={styles.right}>
        <MoneyText amount={amount} style={styles.amount} />
        <StatusPill domain={statusDomain} value={statusValue} />
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14, borderTopWidth: 1, borderTopColor: colors.border },
  body: { flex: 1, minWidth: 0 },
  title: { fontSize: 14, fontWeight: "600", color: colors.slate900 },
  subtitle: { fontSize: 12, color: colors.slate500, marginTop: 2 },
  right: { alignItems: "flex-end", gap: 4 },
  amount: { fontSize: 14, fontWeight: "700", color: colors.slate900 },
});
