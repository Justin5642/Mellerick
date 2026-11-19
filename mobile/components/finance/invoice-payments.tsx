import { useState } from "react";
import { ActivityIndicator, Alert, Platform, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import DateTimePicker, { type DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { MoneyText } from "../../design/components/MoneyText";
import { KeyboardSheet, KEYBOARD_SHEET_INPUT_FONT_SIZE } from "../KeyboardSheet";
import { dateKeyInBusinessTZ } from "../../lib/date";
import { PAYMENT_METHODS, canRecordPayment, parsePayment, paymentMethodLabel } from "../../lib/invoicePayments";
import { recordInvoicePayment, removeInvoicePayment, type InvoicePaymentRow, type InvoicePaymentsState } from "../../lib/invoiceOffice";

// The invoice's Payments card on the phone — the web's (components/invoice/
// invoice-payments.tsx) over the same routes. Online only: invoice_payments is
// in no sync stream, and 0081's triggers move amount_paid / status, which the
// office should see settle while they look. An invoice in Xero takes no
// manual payment (Xero is the record; the app's poll keeps it current).

function fmtDay(key: string): string {
  return new Date(`${key}T12:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * `state` is loaded by the invoice screen (it also says whether Xero is
 * connected); `onChanged` reloads it and the invoice after a payment is
 * recorded or removed.
 */
export function InvoicePayments({
  invoiceId,
  state,
  error,
  onChanged,
}: {
  invoiceId: string;
  state: InvoicePaymentsState | null;
  error: string | null;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(() => dateKeyInBusinessTZ(new Date()));
  const [showDate, setShowDate] = useState(false);
  const [method, setMethod] = useState<string>("bank_transfer");
  const [reference, setReference] = useState("");
  const [saving, setSaving] = useState(false);

  function startRecord() {
    if (!state) return;
    setAmount(state.invoice.balance > 0 ? state.invoice.balance.toFixed(2) : "");
    setPaidOn(dateKeyInBusinessTZ(new Date()));
    setMethod("bank_transfer");
    setReference("");
    setOpen(true);
  }

  async function save() {
    if (!state) return;
    const parsed = parsePayment({ amount, paid_on: paidOn, method, reference });
    if (!parsed.ok) {
      Alert.alert("Can't save yet", parsed.error);
      return;
    }
    setSaving(true);
    try {
      const r = await recordInvoicePayment(invoiceId, parsed.payment);
      setOpen(false);
      Alert.alert("Payment recorded", r.status === "paid" ? "The invoice is paid in full." : "The balance below is what's still owing.");
      onChanged();
    } catch (e) {
      Alert.alert("Not saved", e instanceof Error ? e.message : "The payment could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  function confirmRemove(p: InvoicePaymentRow) {
    Alert.alert("Remove this payment?", `${paymentMethodLabel(p.method)} on ${fmtDay(p.paid_on)}. The invoice goes back to owing it.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: async () => {
          try {
            await removeInvoicePayment(invoiceId, p.id);
            onChanged();
          } catch (e) {
            Alert.alert("Not removed", e instanceof Error ? e.message : "That payment could not be removed.");
          }
        },
      },
    ]);
  }

  function onDateChange(event: DateTimePickerEvent, selected?: Date) {
    setShowDate(Platform.OS === "ios");
    if (event.type === "set" && selected) setPaidOn(dateKeyInBusinessTZ(selected));
  }

  if (error) {
    return (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Payments</Text>
        <Text style={styles.error}>{error}</Text>
        <TouchableOpacity onPress={onChanged} accessibilityRole="button">
          <Text style={styles.link}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (!state) {
    return (
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Payments</Text>
        <ActivityIndicator color={colors.blue600} />
      </View>
    );
  }

  const inv = state.invoice;
  const inXero = !!inv.xero_invoice_id;
  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.cardTitle}>Payments</Text>
        {inv.status === "draft" ? (
          <Text style={styles.muted}>Not sent yet</Text>
        ) : inv.balance > 0 ? (
          <Text style={styles.owing}>
            <MoneyText amount={inv.balance} style={styles.owing} /> owing
          </Text>
        ) : (
          <Text style={styles.paid}>Paid in full</Text>
        )}
      </View>

      {inXero ? (
        <Text style={styles.muted}>
          This invoice is in Xero. Record payments in Xero — the app checks Xero every 30 minutes and updates this invoice (
          <MoneyText amount={inv.amount_paid ?? 0} style={styles.muted} /> paid so far).
        </Text>
      ) : state.payments === null ? (
        <Text style={styles.muted}>Recording payments becomes available once the payments update is applied to the database.</Text>
      ) : (
        <>
          {state.payments.length === 0 ? (
            <Text style={styles.muted}>No payments recorded yet.</Text>
          ) : (
            state.payments.map((p) => (
              <View key={p.id} style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowMain}>
                    <MoneyText amount={p.amount} style={styles.rowMain} /> · {paymentMethodLabel(p.method)}
                  </Text>
                  <Text style={styles.rowSub} numberOfLines={1}>
                    {fmtDay(p.paid_on)}
                    {p.reference ? ` · ${p.reference}` : ""}
                  </Text>
                </View>
                <TouchableOpacity onPress={() => confirmRemove(p)} hitSlop={8} accessibilityLabel="Remove payment">
                  <Ionicons name="trash-outline" size={18} color={colors.slate400} />
                </TouchableOpacity>
              </View>
            ))
          )}
          {canRecordPayment(inv) && (
            <TouchableOpacity style={styles.recordBtn} onPress={startRecord} accessibilityRole="button">
              <Ionicons name="wallet-outline" size={16} color={colors.white} />
              <Text style={styles.recordText}>Record payment</Text>
            </TouchableOpacity>
          )}
        </>
      )}

      <KeyboardSheet
        visible={open}
        onRequestClose={() => !saving && setOpen(false)}
        title="Record payment"
        footer={
          <View style={styles.footer}>
            <TouchableOpacity style={styles.cancelBtn} onPress={() => setOpen(false)} disabled={saving}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.saveBtn, saving && styles.disabled]} onPress={save} disabled={saving}>
              <Text style={styles.saveText}>{saving ? "Saving..." : "Save payment"}</Text>
            </TouchableOpacity>
          </View>
        }
      >
        <Text style={styles.label}>Amount received</Text>
        <TextInput style={styles.input} value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={colors.slate400} />
        <Text style={styles.label}>Date received</Text>
        <TouchableOpacity style={styles.input} onPress={() => setShowDate(true)}>
          <Text style={styles.inputText}>{fmtDay(paidOn)}</Text>
        </TouchableOpacity>
        {showDate && <DateTimePicker value={new Date(`${paidOn}T12:00:00`)} mode="date" onChange={onDateChange} />}
        <Text style={styles.label}>Method</Text>
        <View style={styles.chips}>
          {PAYMENT_METHODS.map((m) => (
            <TouchableOpacity key={m.value} style={[styles.chip, method === m.value && styles.chipOn]} onPress={() => setMethod(m.value)}>
              <Text style={[styles.chipText, method === m.value && styles.chipTextOn]}>{m.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={styles.label}>Reference (optional)</Text>
        <TextInput style={styles.input} value={reference} onChangeText={setReference} placeholder="e.g. bank ref" placeholderTextColor={colors.slate400} />
      </KeyboardSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 14, gap: 8 },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cardTitle: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase" },
  muted: { fontSize: 13, color: colors.slate500, lineHeight: 18 },
  error: { fontSize: 13, color: colors.red600 },
  link: { fontSize: 13, fontWeight: "700", color: colors.blue600 },
  owing: { fontSize: 13, fontWeight: "700", color: colors.orange700 },
  paid: { fontSize: 13, fontWeight: "700", color: colors.green600 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.slate100 },
  rowMain: { fontSize: 14, fontWeight: "600", color: colors.slate900 },
  rowSub: { fontSize: 12, color: colors.slate500, marginTop: 1 },
  recordBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: colors.blue600, borderRadius: 10, paddingVertical: 11, marginTop: 4 },
  recordText: { fontSize: 14, fontWeight: "700", color: colors.white },
  label: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginTop: 10, marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 10,
    fontSize: KEYBOARD_SHEET_INPUT_FONT_SIZE,
    color: colors.slate900,
    backgroundColor: colors.white,
  },
  inputText: { fontSize: KEYBOARD_SHEET_INPUT_FONT_SIZE, color: colors.slate900 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.white },
  chipOn: { borderColor: colors.blue600, backgroundColor: colors.blue100 },
  chipText: { fontSize: 13, color: colors.slate700 },
  chipTextOn: { color: colors.blue600, fontWeight: "700" },
  footer: { flexDirection: "row", gap: 10 },
  cancelBtn: { flex: 1, alignItems: "center", paddingVertical: 13, borderRadius: 10, borderWidth: 1, borderColor: colors.border },
  cancelText: { fontSize: 15, fontWeight: "600", color: colors.slate700 },
  saveBtn: { flex: 2, alignItems: "center", paddingVertical: 13, borderRadius: 10, backgroundColor: colors.blue600 },
  saveText: { fontSize: 15, fontWeight: "700", color: colors.white },
  disabled: { opacity: 0.6 },
});
