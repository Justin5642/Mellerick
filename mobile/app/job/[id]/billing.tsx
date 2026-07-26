import { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, TouchableOpacity, Modal, TextInput, Alert, RefreshControl } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../../lib/theme";
import { MoneyText } from "../../../design/components/MoneyText";
import { getJobBilling, type JobBilling } from "../../../lib/data/reads/jobBilling";
import { useJobBilling } from "../../../lib/data/hooks/useJobBilling";

interface Draft { name: string; quantity: string; unit_price: string; description: string }

export default function JobBillingScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const billing = useJobBilling();
  const [data, setData] = useState<JobBilling | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => { setData(await getJobBilling(id)); setLoading(false); }, [id]);
  useEffect(() => { load(); }, [load]);
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  const lineTotal = data ? data.lineItems.reduce((s, i) => s + Number(i.total ?? 0), 0) : 0;
  const expenseTotal = data ? data.expenses.reduce((s, e) => s + Number(e.amount ?? 0), 0) : 0;

  async function addItem() {
    if (!draft || saving || !billing.ready) return;
    const qty = parseFloat(draft.quantity) || 0;
    const price = parseFloat(draft.unit_price);
    if (!draft.name.trim() || Number.isNaN(price)) { Alert.alert("Missing details", "Name and a numeric unit price are required."); return; }
    setSaving(true);
    try {
      await billing.addLineItem({ jobId: id, name: draft.name.trim(), description: draft.description.trim() || null, quantity: qty, unitPrice: price });
      setDraft(null);
      await load();
    } finally {
      setSaving(false);
    }
  }

  function confirmRemove(itemId: string) {
    Alert.alert("Remove line item", "This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: async () => { await billing.removeLineItem(itemId); await load(); } },
    ]);
  }

  if (loading) return <View style={styles.center}><Stack.Screen options={{ title: "Billing" }} /><ActivityIndicator size="large" color={colors.blue600} /></View>;
  if (!data) return <View style={styles.center}><Stack.Screen options={{ title: "Billing" }} /><Text style={styles.muted}>Job not found.</Text></View>;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.blue600} />}>
      <Stack.Screen options={{ title: data.jobNumber ? `#${data.jobNumber} Billing` : "Billing" }} />

      <View style={styles.sectionHead}>
        <Text style={styles.section}>Line items</Text>
        <TouchableOpacity onPress={() => setDraft({ name: "", quantity: "1", unit_price: "", description: "" })} style={styles.addBtn}>
          <Ionicons name="add" size={16} color={colors.blue600} /><Text style={styles.addText}>Add</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.card}>
        {data.lineItems.length === 0 ? <Text style={styles.empty}>No line items.</Text> : data.lineItems.map((it) => (
          <TouchableOpacity key={it.id} style={styles.lineRow} onLongPress={() => confirmRemove(it.id)}>
            <View style={{ flex: 1 }}>
              <Text style={styles.lineName}>{it.name}</Text>
              <Text style={styles.lineMeta}>{it.quantity} × </Text>
            </View>
            <MoneyText amount={it.unit_price} style={styles.lineMetaMoney} />
            <MoneyText amount={it.total} style={styles.lineTotal} />
          </TouchableOpacity>
        ))}
        {data.lineItems.length > 0 && (
          <View style={styles.subtotalRow}><Text style={styles.subtotalLabel}>Line items total</Text><MoneyText amount={lineTotal} style={styles.subtotalValue} /></View>
        )}
      </View>
      {data.lineItems.length > 0 && <Text style={styles.hint}>Long-press a line item to remove it.</Text>}

      <Text style={styles.section}>Expenses</Text>
      <View style={styles.card}>
        {data.expenses.length === 0 ? <Text style={styles.empty}>No expenses.</Text> : data.expenses.map((e) => (
          <View key={e.id} style={styles.lineRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.lineName}>{e.supplier_name}</Text>
              <Text style={styles.lineMeta}>{e.category.replace(/_/g, " ")}{e.description ? ` · ${e.description}` : ""}</Text>
            </View>
            <MoneyText amount={e.amount} style={styles.lineTotal} />
          </View>
        ))}
        {data.expenses.length > 0 && (
          <View style={styles.subtotalRow}><Text style={styles.subtotalLabel}>Expenses total</Text><MoneyText amount={expenseTotal} style={styles.subtotalValue} /></View>
        )}
      </View>

      {data.purchaseOrders.length > 0 && (
        <>
          <Text style={styles.section}>Purchase orders</Text>
          {data.purchaseOrders.map((po) => (
            <View key={po.id} style={styles.card}>
              <View style={styles.poHead}>
                <Text style={styles.poNumber}>PO #{po.po_number}{po.client_reference ? ` · ${po.client_reference}` : ""}</Text>
                <MoneyText amount={po.total_value} style={styles.poValue} />
              </View>
              {po.po_cost_centers.map((cc) => (
                <View key={cc.id} style={styles.ccRow}>
                  <Text style={styles.ccName}>{cc.name}</Text>
                  <MoneyText amount={cc.allocated_amount} style={styles.ccAmount} />
                </View>
              ))}
            </View>
          ))}
        </>
      )}

      <Text style={styles.footnote}>Expense capture (with receipts) and PO editing are managed on the web dashboard.</Text>

      <Modal visible={!!draft} transparent animationType="slide" onRequestClose={() => !saving && setDraft(null)}>
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Add line item</Text>
            <Field label="Name" value={draft?.name ?? ""} onChange={(v) => setDraft((d) => d && { ...d, name: v })} />
            <Field label="Description (optional)" value={draft?.description ?? ""} onChange={(v) => setDraft((d) => d && { ...d, description: v })} />
            <View style={styles.twoCol}>
              <View style={{ flex: 1 }}><Field label="Qty" value={draft?.quantity ?? ""} onChange={(v) => setDraft((d) => d && { ...d, quantity: v })} num /></View>
              <View style={{ flex: 1 }}><Field label="Unit price" value={draft?.unit_price ?? ""} onChange={(v) => setDraft((d) => d && { ...d, unit_price: v })} num /></View>
            </View>
            <View style={styles.actions}>
              <TouchableOpacity style={styles.cancel} onPress={() => setDraft(null)} disabled={saving}><Text style={styles.cancelText}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity style={styles.saveBtn} onPress={addItem} disabled={saving}><Text style={styles.saveText}>{saving ? "…" : "Add"}</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

function Field({ label, value, onChange, num }: { label: string; value: string; onChange: (v: string) => void; num?: boolean }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput style={styles.input} value={value} onChangeText={onChange} keyboardType={num ? "decimal-pad" : "default"} placeholderTextColor={colors.slate400} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 40, gap: 6 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  muted: { fontSize: 13, color: colors.slate500 },
  section: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginTop: 14, marginBottom: 8, marginLeft: 4 },
  sectionHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 8 },
  addBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
  addText: { fontSize: 13, color: colors.blue600, fontWeight: "600" },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12, gap: 2 },
  empty: { fontSize: 13, color: colors.slate400, paddingVertical: 8, textAlign: "center" },
  lineRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.slate100 },
  lineName: { fontSize: 14, fontWeight: "600", color: colors.slate900 },
  lineMeta: { fontSize: 12, color: colors.slate500, marginTop: 1 },
  lineMetaMoney: { fontSize: 12, color: colors.slate500 },
  lineTotal: { fontSize: 14, fontWeight: "700", color: colors.slate900, width: 76, textAlign: "right" },
  subtotalRow: { flexDirection: "row", justifyContent: "space-between", paddingTop: 8 },
  subtotalLabel: { fontSize: 13, fontWeight: "700", color: colors.slate700 },
  subtotalValue: { fontSize: 15, fontWeight: "800", color: colors.slate900 },
  hint: { fontSize: 11, color: colors.slate400, marginLeft: 4 },
  poHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 4 },
  poNumber: { fontSize: 14, fontWeight: "700", color: colors.slate900, flex: 1 },
  poValue: { fontSize: 14, fontWeight: "700", color: colors.slate900 },
  ccRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3, paddingLeft: 8 },
  ccName: { fontSize: 13, color: colors.slate500 },
  ccAmount: { fontSize: 13, color: colors.slate700 },
  footnote: { fontSize: 11, color: colors.slate400, textAlign: "center", marginTop: 14 },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, paddingBottom: 28 },
  sheetTitle: { fontSize: 16, fontWeight: "800", color: colors.slate900, marginBottom: 12 },
  field: { marginBottom: 12 },
  fieldLabel: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginBottom: 6 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, backgroundColor: colors.bg, color: colors.slate900 },
  twoCol: { flexDirection: "row", gap: 12 },
  actions: { flexDirection: "row", gap: 10, marginTop: 8 },
  cancel: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.bg, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  cancelText: { color: colors.slate700, fontWeight: "600", fontSize: 14 },
  saveBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.blue600, alignItems: "center" },
  saveText: { color: "#fff", fontWeight: "700", fontSize: 14 },
});
