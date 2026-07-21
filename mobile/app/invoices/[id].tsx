import { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, ActivityIndicator } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { colors } from "../../lib/theme";
import { formatInvoiceNumber } from "../../lib/finance";
import { MoneyText } from "../../design/components/MoneyText";
import { StatusPill } from "../../design/components/StatusPill";
import { getInvoice, type InvoiceDetail } from "../../lib/data/reads/finance";

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "—";
}

export default function InvoiceDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setInvoice(await getInvoice(id));
    setLoading(false);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: "Invoice" }} />
        <ActivityIndicator size="large" color={colors.blue600} />
      </View>
    );
  }
  if (!invoice) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: "Invoice" }} />
        <Text style={styles.muted}>Invoice not found.</Text>
      </View>
    );
  }

  const c = invoice.customers;
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: formatInvoiceNumber(invoice.invoice_number) }} />

      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.number}>{formatInvoiceNumber(invoice.invoice_number)}</Text>
          <Text style={styles.title}>{invoice.title}</Text>
        </View>
        <StatusPill domain="invoiceStatus" value={invoice.status} />
      </View>

      {c && (
        <Card title="Customer">
          <Text style={styles.customerName}>{c.name}</Text>
          {!!c.email && <Text style={styles.muted}>{c.email}</Text>}
          {!!c.phone && <Text style={styles.muted}>{c.phone}</Text>}
        </Card>
      )}

      <Card title="Details">
        <Row label="Created" value={fmtDate(invoice.created_at)} />
        {invoice.due_date ? <Row label="Due" value={fmtDate(invoice.due_date)} /> : null}
        {invoice.xero_invoice_id ? <Row label="Xero ID" value={invoice.xero_invoice_id} mono /> : null}
      </Card>

      <Card title="Line Items">
        <View style={styles.lineHead}>
          <Text style={[styles.lineHeadText, { flex: 1 }]}>Item</Text>
          <Text style={[styles.lineHeadText, styles.qtyCol]}>Qty</Text>
          <Text style={[styles.lineHeadText, styles.moneyCol]}>Unit</Text>
          <Text style={[styles.lineHeadText, styles.moneyCol]}>Total</Text>
        </View>
        {invoice.invoice_items.map((item) => (
          <View key={item.id} style={styles.lineRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.lineName}>{item.name}</Text>
              {!!item.description && <Text style={styles.lineDesc}>{item.description}</Text>}
            </View>
            <Text style={[styles.lineCell, styles.qtyCol]}>{item.quantity}</Text>
            <MoneyText amount={item.unit_price} style={[styles.lineCell, styles.moneyCol]} />
            <MoneyText amount={item.total} style={[styles.lineCell, styles.moneyCol, styles.bold]} />
          </View>
        ))}
        <View style={styles.totals}>
          <TotalRow label="Subtotal (ex GST)" amount={invoice.subtotal} />
          <TotalRow label="GST (10%)" amount={invoice.tax_amount} />
          <TotalRow label="Total" amount={invoice.total} strong />
        </View>
      </Card>

      {!!invoice.work_description && (
        <Card title="Work Carried Out">
          <Text style={styles.body}>{invoice.work_description}</Text>
        </Card>
      )}
      {!!invoice.notes && (
        <Card title="Notes">
          <Text style={styles.body}>{invoice.notes}</Text>
        </Card>
      )}

      <Text style={styles.footnote}>Sending, PDF and Xero are managed on the web dashboard.</Text>
    </ScrollView>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      {children}
    </View>
  );
}
function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.kv}>
      <Text style={styles.kvLabel}>{label}</Text>
      <Text style={[styles.kvValue, mono && styles.mono]}>{value}</Text>
    </View>
  );
}
function TotalRow({ label, amount, strong }: { label: string; amount: number | null; strong?: boolean }) {
  return (
    <View style={styles.kv}>
      <Text style={[styles.kvLabel, strong && styles.bold]}>{label}</Text>
      <MoneyText amount={amount} style={[styles.kvValue, strong && styles.totalStrong]} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 14, paddingBottom: 40 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  headerRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  number: { fontSize: 13, fontWeight: "700", color: colors.blue600 },
  title: { fontSize: 18, fontWeight: "800", color: colors.slate900, marginTop: 2 },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 14, gap: 6 },
  cardTitle: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginBottom: 4 },
  customerName: { fontSize: 15, fontWeight: "700", color: colors.slate900 },
  muted: { fontSize: 13, color: colors.slate500 },
  body: { fontSize: 14, color: colors.slate700, lineHeight: 20 },
  kv: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 3 },
  kvLabel: { fontSize: 13, color: colors.slate500 },
  kvValue: { fontSize: 13, color: colors.slate900, fontWeight: "500" },
  mono: { fontFamily: "monospace" },
  lineHead: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: colors.border, paddingBottom: 6, marginTop: 2 },
  lineHeadText: { fontSize: 11, fontWeight: "700", color: colors.slate400, textTransform: "uppercase" },
  lineRow: { flexDirection: "row", alignItems: "center", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.slate100 },
  lineName: { fontSize: 13, fontWeight: "600", color: colors.slate900 },
  lineDesc: { fontSize: 11, color: colors.slate400, marginTop: 1 },
  lineCell: { fontSize: 13, color: colors.slate700, textAlign: "right" },
  qtyCol: { width: 40, textAlign: "right" },
  moneyCol: { width: 76, textAlign: "right" },
  bold: { fontWeight: "700", color: colors.slate900 },
  totals: { marginTop: 10, gap: 2 },
  totalStrong: { fontSize: 16, fontWeight: "800", color: colors.slate900 },
  footnote: { fontSize: 11, color: colors.slate400, textAlign: "center", marginTop: 4 },
});
