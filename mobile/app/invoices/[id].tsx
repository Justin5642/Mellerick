import { useCallback, useState } from "react";
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, TouchableOpacity, Alert, RefreshControl } from "react-native";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { formatInvoiceNumber } from "../../lib/finance";
import { MoneyText } from "../../design/components/MoneyText";
import { StatusPill } from "../../design/components/StatusPill";
import { ScreenError } from "../../design/components/ScreenError";
import { RoleGate } from "../../design/guards/RoleGate";
import { useIsAdmin } from "../../design/guards/useRole";
import { getInvoice, type InvoiceDetail } from "../../lib/data/reads/finance";
import { markWritesSettled } from "../../lib/data/reads/source";
import { invoiceProgress } from "../../lib/progressClaim";
import { deleteInvoiceMessage, pushedMessage, pushFailedMessage, pushToXeroLabel, unpricedPushConfirm } from "../../lib/invoiceActions";
import { ApiError, deleteInvoice, loadInvoicePayments, pushInvoiceToXero, type InvoicePaymentsState } from "../../lib/invoiceOffice";
import { DocumentPdfButton } from "../../components/finance/document-pdf-button";
import { InvoicePayments } from "../../components/finance/invoice-payments";
import { InvoiceHours } from "../../components/finance/invoice-hours";

// The office's invoice screen. Office/admin only: the route is registered for
// the office group alone (app/_layout.tsx) and the screen sits in a RoleGate;
// every action's route checks the role again (requireOfficeOrAdmin, or
// requireAdmin for Xero). The invoice reads locally when it can;
// PDF, Xero, payments, hours and delete go to the web routes and need signal
// (lib/invoiceOffice.ts).

function fmtDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "—";
}

export default function InvoiceDetailScreen() {
  return (
    <RoleGate
      roles={["office", "admin"]}
      fallback={
        <View style={styles.center}>
          <Stack.Screen options={{ title: "Invoice" }} />
          <Text style={styles.muted}>Only the office can see invoices.</Text>
        </View>
      }
    >
      <InvoiceScreen />
    </RoleGate>
  );
}

function InvoiceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const isAdmin = useIsAdmin();
  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // Online parts: payments, and whether Xero is connected.
  const [office, setOffice] = useState<InvoicePaymentsState | null>(null);
  const [officeError, setOfficeError] = useState<string | null>(null);
  const [unpricedHours, setUnpricedHours] = useState(0);
  const [hoursKey, setHoursKey] = useState(0);
  const [pushing, setPushing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    // getInvoice THROWS on a failed query. Without this catch the throw
    // skips setLoading(false) and the screen spins forever; with it, a failure
    // is reported instead of being mistaken for "Invoice not found."
    try {
      setError(null);
      setInvoice(await getInvoice(id));
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [id]);

  const loadOffice = useCallback(async () => {
    try {
      setOfficeError(null);
      setOffice(await loadInvoicePayments(id));
    } catch (e) {
      setOfficeError(e instanceof Error ? e.message : "The payments could not be loaded.");
    }
  }, [id]);

  // On focus, not just mount: coming back from Send or Edit shows what changed.
  useFocusEffect(
    useCallback(() => {
      void load();
      void loadOffice();
    }, [load, loadOffice])
  );

  // After a write on the server: read the invoice from Supabase for a moment,
  // not the mirror that hasn't caught up yet.
  const afterServerWrite = useCallback(async () => {
    markWritesSettled();
    await Promise.all([load(), loadOffice()]);
  }, [load, loadOffice]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([load(), loadOffice()]);
    setHoursKey((k) => k + 1);
    setRefreshing(false);
  }, [load, loadOffice]);

  const onUnpricedChange = useCallback((h: number) => setUnpricedHours(h), []);

  async function push(confirmUnpriced: boolean) {
    if (!invoice) return;
    setPushing(true);
    const pushed = !!invoice.xero_invoice_id;
    try {
      const r = await pushInvoiceToXero(invoice.id, confirmUnpriced);
      Alert.alert("Xero", pushedMessage(r.updated));
      await afterServerWrite();
    } catch (e) {
      if (e instanceof ApiError && e.code === "unpriced_hours" && !confirmUnpriced) {
        Alert.alert("Hours not on this invoice", `${e.message}\n\nPush it without them?`, [
          { text: "Cancel", style: "cancel" },
          { text: "Push anyway", onPress: () => void push(true) },
        ]);
      } else {
        Alert.alert("Xero", e instanceof Error ? e.message : pushFailedMessage(pushed));
      }
    } finally {
      setPushing(false);
    }
  }

  function startPush() {
    if (unpricedHours > 0) {
      Alert.alert("Hours not priced", unpricedPushConfirm(unpricedHours), [
        { text: "Cancel", style: "cancel" },
        { text: "Push anyway", onPress: () => void push(true) },
      ]);
    } else {
      void push(false);
    }
  }

  function confirmDelete() {
    if (!invoice) return;
    const inXero = !!invoice.xero_invoice_id;
    Alert.alert(`Delete invoice ${formatInvoiceNumber(invoice.invoice_number)}?`, deleteInvoiceMessage(invoice.title, inXero), [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete Invoice",
        style: "destructive",
        onPress: async () => {
          setDeleting(true);
          try {
            await deleteInvoice(invoice.id);
            markWritesSettled();
            router.back();
            if (inXero) Alert.alert("Invoice deleted", "It is still in Xero — void or delete it there too.");
          } catch (e) {
            Alert.alert("Not deleted", e instanceof Error ? e.message : "The invoice could not be deleted. Please try again.");
            setDeleting(false);
          }
        },
      },
    ]);
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: "Invoice" }} />
        <ActivityIndicator size="large" color={colors.blue600} />
      </View>
    );
  }
  // Checked BEFORE "Invoice not found." — a failed read must never be shown as a
  // missing invoice. That confusion is the entire bug.
  if (error) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: "Invoice" }} />
        <ScreenError
          error={error}
          onRetry={() => {
            setLoading(true);
            void load();
          }}
        />
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
  const progress = invoiceProgress({ ...invoice, subtotal: invoice.subtotal ?? 0 });
  const pushed = !!invoice.xero_invoice_id;
  const number = formatInvoiceNumber(invoice.invoice_number);
  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
      <Stack.Screen
        options={{
          title: number,
          headerRight: () => (
            <TouchableOpacity onPress={() => router.push(`/invoices/${id}/edit`)} accessibilityLabel="Edit invoice">
              <Ionicons name="create-outline" size={22} color={colors.blue600} />
            </TouchableOpacity>
          ),
        }}
      />

      <View style={styles.headerRow}>
        <View style={{ flex: 1 }}>
          <Text style={styles.number}>{number}</Text>
          <Text style={styles.title}>{invoice.title}</Text>
        </View>
        <StatusPill domain="invoiceStatus" value={invoice.status} />
      </View>

      <View style={styles.actions}>
        <DocumentPdfButton kind="invoice" id={invoice.id} number={invoice.invoice_number} title={`Invoice ${number}`} />
        <TouchableOpacity style={styles.sendBtn} onPress={() => router.push(`/invoices/${id}/send`)} accessibilityRole="button">
          <Ionicons name="send" size={16} color={colors.white} />
          <Text style={styles.sendText}>{invoice.status === "draft" ? "Send to Customer" : "Resend"}</Text>
        </TouchableOpacity>
      </View>

      <XeroRow
        pushed={pushed}
        connected={office?.xeroConnected ?? null}
        isAdmin={isAdmin}
        pushing={pushing}
        onPush={startPush}
      />

      {c && (
        <Card title="Customer">
          <Text style={styles.customerName}>{c.name}</Text>
          {!!c.email && <Text style={styles.muted}>{c.email}</Text>}
          {!!c.phone && <Text style={styles.muted}>{c.phone}</Text>}
        </Card>
      )}

      <Card title="Details">
        <Row label="Created" value={fmtDate(invoice.created_at)} />
        {invoice.customer_po ? <Row label="Customer PO" value={invoice.customer_po} /> : null}
        {invoice.due_date ? <Row label="Due" value={fmtDate(invoice.due_date)} /> : null}
        {invoice.xero_invoice_id ? <Row label="Xero ID" value={invoice.xero_invoice_id} mono /> : null}
      </Card>

      {progress && (
        <Card title={`Progress claim no. ${progress.claimNumber}`}>
          <Text style={styles.muted}>{progress.pctToDate}% claimed to date</Text>
          <TotalRow label="Contract value (ex GST)" amount={progress.contractValue} />
          <TotalRow label={`Previously claimed · ${progress.pctPrevious}%`} amount={progress.previous} />
          <TotalRow label={`This claim · ${progress.pctThis}%`} amount={progress.thisClaim} />
          <TotalRow label={`Claimed to date · ${progress.pctToDate}%`} amount={progress.toDate} />
          <TotalRow label="Balance to claim" amount={progress.balance} strong negative={progress.balance < 0} />
        </Card>
      )}

      <InvoicePayments invoiceId={invoice.id} state={office} error={officeError} onChanged={() => void afterServerWrite()} />

      {invoice.job_id ? (
        <InvoiceHours
          key={hoursKey}
          invoiceId={invoice.id}
          inXero={pushed}
          onUnpricedChange={onUnpricedChange}
          onApplied={() => void afterServerWrite()}
        />
      ) : null}

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

      <RoleGate roles={["admin", "office"]}>
        <TouchableOpacity style={[styles.deleteBtn, deleting && styles.disabled]} onPress={confirmDelete} disabled={deleting} accessibilityRole="button">
          <Ionicons name="trash-outline" size={16} color={colors.red600} />
          <Text style={styles.deleteText}>{deleting ? "Deleting..." : "Delete invoice"}</Text>
        </TouchableOpacity>
      </RoleGate>
    </ScrollView>
  );
}

/** "In Xero" and Push / Update in Xero — the push itself is admin only (the route's requireAdmin). */
function XeroRow({
  pushed,
  connected,
  isAdmin,
  pushing,
  onPush,
}: {
  pushed: boolean;
  /** null while the online check hasn't answered. */
  connected: boolean | null;
  isAdmin: boolean;
  pushing: boolean;
  onPush: () => void;
}) {
  if (!pushed && !isAdmin) return null;
  return (
    <View style={styles.xeroRow}>
      {pushed && (
        <View style={styles.inXero}>
          <Ionicons name="checkmark-circle" size={16} color={colors.green600} />
          <Text style={styles.inXeroText}>In Xero</Text>
        </View>
      )}
      {isAdmin && connected === true && (
        <TouchableOpacity style={[styles.xeroBtn, pushed && styles.xeroBtnOutline, pushing && styles.disabled]} onPress={onPush} disabled={pushing} accessibilityRole="button">
          {pushing ? <ActivityIndicator size="small" color={pushed ? colors.blue600 : colors.white} /> : <Ionicons name="cloud-upload-outline" size={16} color={pushed ? colors.blue600 : colors.white} />}
          <Text style={[styles.xeroText, pushed && styles.xeroTextOutline]}>{pushToXeroLabel(pushed, pushing)}</Text>
        </TouchableOpacity>
      )}
      {isAdmin && connected === false && !pushed && <Text style={styles.muted}>Connect Xero on the web dashboard (Settings) first.</Text>}
    </View>
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
function TotalRow({ label, amount, strong, negative }: { label: string; amount: number | null; strong?: boolean; negative?: boolean }) {
  return (
    <View style={styles.kv}>
      <Text style={[styles.kvLabel, strong && styles.bold]}>{label}</Text>
      <MoneyText amount={amount} style={[styles.kvValue, strong && styles.totalStrong, negative && styles.negative]} />
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
  actions: { flexDirection: "row", gap: 10 },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 14, gap: 6 },
  cardTitle: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginBottom: 4 },
  customerName: { fontSize: 15, fontWeight: "700", color: colors.slate900 },
  muted: { fontSize: 13, color: colors.slate500 },
  body: { fontSize: 14, color: colors.slate700, lineHeight: 20 },
  kv: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 3 },
  kvLabel: { fontSize: 13, color: colors.slate500 },
  kvValue: { fontSize: 13, color: colors.slate900, fontWeight: "500" },
  mono: { fontFamily: "monospace" },
  negative: { color: colors.red600 },
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
  sendBtn: {
    flex: 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: colors.blue600,
    borderRadius: 10,
    paddingVertical: 12,
  },
  sendText: { fontSize: 15, fontWeight: "700", color: colors.white },
  xeroRow: { flexDirection: "row", alignItems: "center", gap: 12, flexWrap: "wrap" },
  inXero: { flexDirection: "row", alignItems: "center", gap: 4 },
  inXeroText: { fontSize: 13, fontWeight: "700", color: colors.green600 },
  xeroBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: colors.blue600,
    borderRadius: 10,
    paddingVertical: 11,
  },
  xeroBtnOutline: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.blue600 },
  xeroText: { fontSize: 14, fontWeight: "700", color: colors.white },
  xeroTextOutline: { color: colors.blue600 },
  deleteBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: colors.red600,
    borderRadius: 10,
    paddingVertical: 12,
    marginTop: 6,
  },
  deleteText: { fontSize: 14, fontWeight: "700", color: colors.red600 },
  disabled: { opacity: 0.6 },
});
