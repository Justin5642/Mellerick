import { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { MoneyText } from "../../design/components/MoneyText";
import { RoleGate } from "../../design/guards/RoleGate";
import type { OwedSummary } from "../../lib/invoicePayments";

// "Owed to us" on the office Invoices screen — the web's components/invoice/
// owed-to-us.tsx: outstanding / overdue / not yet due, then every sent or
// overdue invoice with a balance, grouped by how late it is. Balances, not
// totals, so a part-paid invoice counts only what is still owing. Summed by
// lib/invoicePayments.ts summarizeOwed (mirror of the web's).

const BUCKET_TONE: Record<string, string> = {
  current: colors.slate700,
  "1-30": colors.orange700,
  "31-60": colors.orange700,
  "61-90": colors.red600,
  "90+": colors.red600,
};

export function OwedToUs({ summary }: { summary: OwedSummary }) {
  const router = useRouter();
  // Overdue groups start open; "not yet due" starts closed.
  const [open, setOpen] = useState<Set<string>>(
    () => new Set(summary.buckets.filter((b) => b.key !== "current" && b.invoices.length > 0).map((b) => b.key))
  );
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <RoleGate roles={["office", "admin"]}>
      <View style={styles.card}>
        <Text style={styles.title}>Owed to us</Text>
        {summary.count === 0 ? (
          <Text style={styles.muted}>Nothing owed — every sent invoice is paid.</Text>
        ) : (
          <>
            <View style={styles.tiles}>
              <View style={styles.tile}>
                <Text style={styles.tileLabel}>Outstanding</Text>
                <MoneyText amount={summary.outstanding} style={styles.tileValue} />
                <Text style={styles.tileSub}>
                  {summary.count} invoice{summary.count === 1 ? "" : "s"}
                </Text>
              </View>
              <View style={[styles.tile, styles.tileRed]}>
                <Text style={[styles.tileLabel, styles.red]}>Overdue</Text>
                <MoneyText amount={summary.overdue} style={[styles.tileValue, styles.red]} />
              </View>
              <View style={styles.tile}>
                <Text style={styles.tileLabel}>Not yet due</Text>
                <MoneyText amount={Math.max(0, summary.outstanding - summary.overdue)} style={styles.tileValue} />
              </View>
            </View>
            {summary.buckets
              .filter((b) => b.invoices.length > 0)
              .map((b) => (
                <View key={b.key} style={styles.bucket}>
                  <TouchableOpacity style={styles.bucketHead} onPress={() => toggle(b.key)} accessibilityRole="button" accessibilityState={{ expanded: open.has(b.key) }}>
                    <Ionicons name={open.has(b.key) ? "chevron-down" : "chevron-forward"} size={14} color={BUCKET_TONE[b.key]} />
                    <Text style={[styles.bucketLabel, { color: BUCKET_TONE[b.key] }]}>
                      {b.label} <Text style={styles.muted}>({b.invoices.length})</Text>
                    </Text>
                    <MoneyText amount={b.total} style={styles.bucketTotal} />
                  </TouchableOpacity>
                  {open.has(b.key) &&
                    b.invoices.map((inv) => (
                      <TouchableOpacity key={inv.id} style={styles.inv} onPress={() => router.push(`/invoices/${inv.id}`)}>
                        <Text style={styles.invText} numberOfLines={1}>
                          <Text style={styles.muted}>#{inv.invoice_number}</Text> {inv.customers?.name ?? "—"}
                          {inv.daysOverdue > 0 ? <Text style={styles.late}> · {inv.daysOverdue} days late</Text> : null}
                        </Text>
                        <MoneyText amount={inv.balance} style={styles.invAmount} />
                      </TouchableOpacity>
                    ))}
                </View>
              ))}
          </>
        )}
      </View>
    </RoleGate>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, margin: 12, marginBottom: 0, borderRadius: 12, padding: 12, gap: 8 },
  title: { fontSize: 13, fontWeight: "700", color: colors.slate900 },
  muted: { fontSize: 12, color: colors.slate500, fontWeight: "400" },
  tiles: { flexDirection: "row", gap: 8 },
  tile: { flex: 1, backgroundColor: colors.slate100, borderRadius: 8, padding: 8 },
  tileRed: { backgroundColor: colors.red100 },
  tileLabel: { fontSize: 11, color: colors.slate500 },
  tileValue: { fontSize: 14, fontWeight: "800", color: colors.slate900 },
  tileSub: { fontSize: 11, color: colors.slate500 },
  red: { color: colors.red600 },
  bucket: { borderTopWidth: 1, borderTopColor: colors.border },
  bucketHead: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 8 },
  bucketLabel: { flex: 1, fontSize: 13, fontWeight: "700" },
  bucketTotal: { fontSize: 13, fontWeight: "700", color: colors.slate900 },
  inv: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6, paddingLeft: 20 },
  invText: { flex: 1, fontSize: 13, color: colors.slate900 },
  late: { fontSize: 11, color: colors.slate400 },
  invAmount: { fontSize: 13, color: colors.slate900 },
});
