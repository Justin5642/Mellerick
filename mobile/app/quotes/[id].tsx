import { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, TouchableOpacity, Alert } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { formatQuoteNumber } from "../../lib/finance";
import { MoneyText } from "../../design/components/MoneyText";
import { StatusPill } from "../../design/components/StatusPill";
import { getQuote, type QuoteDetail } from "../../lib/data/reads/finance";
import { useFinance } from "../../lib/data/hooks/useFinance";
import { useJobEdit } from "../../lib/data/hooks/useJobEdit";
import { useAuth } from "../../lib/auth-context";

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "—";
}

export default function QuoteDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const finance = useFinance();
  const jobEdit = useJobEdit();
  const { profile } = useAuth();
  const [quote, setQuote] = useState<QuoteDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);

  const load = useCallback(async () => {
    setQuote(await getQuote(id));
    setLoading(false);
  }, [id]);

  const setStatus = useCallback(async (status: "accepted" | "declined") => {
    if (updating || !finance.ready) return;
    setUpdating(true);
    try {
      await finance.setQuoteStatus(id, status);
      setQuote((q) => (q ? { ...q, status } : q)); // apply once the write is queued/synced
    } catch (e) {
      Alert.alert("Couldn't update quote", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setUpdating(false);
    }
  }, [id, finance, updating]);

  const convert = useCallback(async () => {
    if (!quote || updating || !jobEdit.ready) return;
    if (quote.job_id) { router.push(`/job/${quote.job_id}`); return; }
    setUpdating(true);
    try {
      const { id: newJobId, synced } = await jobEdit.convertQuoteToJob({
        quoteId: quote.id,
        title: quote.title,
        notes: quote.notes,
        customerId: quote.customer_id,
        siteId: quote.site_id,
        createdBy: profile?.id ?? null,
        items: quote.quote_items.map((i) => ({ name: i.name, description: i.description ?? null, quantity: Number(i.quantity), unitPrice: Number(i.unit_price) })),
      });
      setQuote((q) => (q ? { ...q, job_id: newJobId } : q)); // optimistic
      if (synced) router.push(`/job/${newJobId}`);
      else Alert.alert("Saved offline", "The job is queued and will sync when you're back online.");
    } catch (e) {
      Alert.alert("Couldn't convert", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setUpdating(false);
    }
  }, [quote, updating, jobEdit, profile, router]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: "Quote" }} />
        <ActivityIndicator size="large" color={colors.blue600} />
      </View>
    );
  }
  if (!quote) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: "Quote" }} />
        <Text style={styles.muted}>Quote not found.</Text>
      </View>
    );
  }

  const c = quote.customers;
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Stack.Screen
        options={{
          title: formatQuoteNumber(quote.quote_number),
          headerRight: () => (
            <TouchableOpacity onPress={() => router.push(`/quotes/${id}/edit`)} accessibilityLabel="Edit quote">
              <Ionicons name="create-outline" size={22} color={colors.blue600} />
            </TouchableOpacity>
          ),
        }}
      />

      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.number}>{formatQuoteNumber(quote.quote_number)}</Text>
          <Text style={styles.title}>{quote.title}</Text>
        </View>
        <StatusPill domain="quoteStatus" value={quote.status} />
      </View>

      {quote.status === "sent" && (
        <View style={styles.decision}>
          <TouchableOpacity style={[styles.decisionBtn, styles.decline]} onPress={() => setStatus("declined")} disabled={updating}>
            <Ionicons name="close" size={16} color={colors.red600} />
            <Text style={styles.declineText}>Decline</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.decisionBtn, styles.accept]} onPress={() => setStatus("accepted")} disabled={updating}>
            <Ionicons name="checkmark" size={16} color="#fff" />
            <Text style={styles.acceptText}>Accept</Text>
          </TouchableOpacity>
        </View>
      )}

      {quote.status === "accepted" && (
        quote.job_id ? (
          <TouchableOpacity style={styles.convertedRow} onPress={() => router.push(`/job/${quote.job_id}`)}>
            <Ionicons name="checkmark-circle" size={16} color={colors.green600} />
            <Text style={styles.convertedText}>Converted to a job — open</Text>
            <Ionicons name="chevron-forward" size={16} color={colors.green600} />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={styles.convertBtn} onPress={convert} disabled={updating}>
            <Ionicons name="briefcase-outline" size={16} color="#fff" />
            <Text style={styles.convertText}>{updating ? "Creating job…" : "Convert to Job"}</Text>
          </TouchableOpacity>
        )
      )}

      {c && (
        <Card title="Customer">
          <Text style={styles.customerName}>{c.name}</Text>
          {!!c.email && <Text style={styles.muted}>{c.email}</Text>}
          {!!c.phone && <Text style={styles.muted}>{c.phone}</Text>}
        </Card>
      )}

      <Card title="Details">
        <Row label="Created" value={fmtDate(quote.created_at)} />
        {quote.valid_until ? <Row label="Valid until" value={fmtDate(quote.valid_until)} /> : null}
      </Card>

      <Card title="Line Items">
        <View style={styles.lineHead}>
          <Text style={[styles.lineHeadText, { flex: 1 }]}>Item</Text>
          <Text style={[styles.lineHeadText, styles.qtyCol]}>Qty</Text>
          <Text style={[styles.lineHeadText, styles.moneyCol]}>Unit</Text>
          <Text style={[styles.lineHeadText, styles.moneyCol]}>Total</Text>
        </View>
        {quote.quote_items.map((item) => (
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
          <TotalRow label="Subtotal (ex GST)" amount={quote.subtotal} />
          <TotalRow label="GST (10%)" amount={quote.tax_amount} />
          <TotalRow label="Total" amount={quote.total} strong />
        </View>
      </Card>

      {!!quote.notes && (
        <Card title="Notes">
          <Text style={styles.body}>{quote.notes}</Text>
        </Card>
      )}

      <Text style={styles.footnote}>Sending and PDF are managed on the web dashboard.</Text>
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
function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.kv}>
      <Text style={styles.kvLabel}>{label}</Text>
      <Text style={styles.kvValue}>{value}</Text>
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
  decision: { flexDirection: "row", gap: 10 },
  decisionBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 12, borderRadius: 10 },
  decline: { backgroundColor: colors.red100, borderWidth: 1, borderColor: colors.red600 },
  declineText: { color: colors.red600, fontWeight: "700", fontSize: 14 },
  accept: { backgroundColor: colors.green600 },
  acceptText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  convertBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: colors.blue600, borderRadius: 10, paddingVertical: 13 },
  convertText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  convertedRow: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.green100, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 14 },
  convertedText: { flex: 1, color: colors.green600, fontWeight: "700", fontSize: 13 },
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
