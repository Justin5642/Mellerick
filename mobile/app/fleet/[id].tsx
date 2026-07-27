import { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, TouchableOpacity, Modal, TextInput, Alert, RefreshControl, Linking } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { colors } from "../../lib/theme";
import { MoneyText } from "../../design/components/MoneyText";
import { computeEquipmentCost } from "../../lib/costing";
import { getEquipment, listEquipmentExpenses, listEquipmentUsage, listEquipmentDocuments, getEquipmentReceiptSignedUrl, getEquipmentDocumentSignedUrl, type Equipment, type EquipmentExpense, type EquipmentUsage, type EquipmentDocument } from "../../lib/data/reads/fleet";
import { useFleet } from "../../lib/data/hooks/useFleet";
import { useAuth } from "../../lib/auth-context";
import type { EquipmentExpenseCategory } from "../../lib/data/repositories/fleet";

const CATEGORIES: EquipmentExpenseCategory[] = ["service", "repair", "fuel", "tyres", "registration", "insurance", "other"];

interface Draft {
  category: EquipmentExpenseCategory;
  supplier_name: string;
  description: string;
  invoice_number: string;
  expense_date: string;
  amount: string;
  gst_amount: string;
  receiptUri: string | null;
}
const emptyDraft: Draft = { category: "service", supplier_name: "", description: "", invoice_number: "", expense_date: "", amount: "", gst_amount: "", receiptUri: null };

export default function EquipmentDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const fleet = useFleet();
  const { profile } = useAuth();
  const [equipment, setEquipment] = useState<Equipment | null>(null);
  const [expenses, setExpenses] = useState<EquipmentExpense[]>([]);
  const [usage, setUsage] = useState<EquipmentUsage[]>([]);
  const [documents, setDocuments] = useState<EquipmentDocument[]>([]);
  const [openingDocId, setOpeningDocId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [usageDraft, setUsageDraft] = useState<{ usageDate: string; hours: string; notes: string } | null>(null);
  const [usageSaving, setUsageSaving] = useState(false);

  const load = useCallback(async () => {
    const [e, ex, us, docs] = await Promise.all([getEquipment(id), listEquipmentExpenses(id), listEquipmentUsage(id), listEquipmentDocuments(id)]);
    setEquipment(e);
    setExpenses(ex);
    setUsage(us);
    setDocuments(docs);
    setLoading(false);
  }, [id]);

  async function openDocument(doc: EquipmentDocument) {
    setOpeningDocId(doc.id);
    const url = await getEquipmentDocumentSignedUrl(doc.storage_path);
    setOpeningDocId(null);
    if (url) Linking.openURL(url);
    else Alert.alert("Couldn't open document", "It may still be uploading, or you're offline.");
  }

  async function addUsage() {
    if (!usageDraft || usageSaving || !fleet.ready) return;
    const hours = parseFloat(usageDraft.hours);
    if (Number.isNaN(hours) || hours <= 0) { Alert.alert("Missing details", "A valid number of hours is required."); return; }
    if (!profile?.id) { Alert.alert("Not ready", "Your profile is still loading — please try again."); return; }
    setUsageSaving(true);
    try {
      await fleet.addEquipmentUsage({ equipmentId: id, loggedBy: profile.id, usageDate: usageDraft.usageDate.trim() || null, hours, notes: usageDraft.notes.trim() || null });
      setUsageDraft(null);
      await load();
    } catch (e) {
      Alert.alert("Couldn't save", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setUsageSaving(false);
    }
  }
  function confirmRemoveUsage(u: EquipmentUsage) {
    Alert.alert("Remove usage", "This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: async () => { await fleet.removeEquipmentUsage(u.id); await load(); } },
    ]);
  }
  useEffect(() => { load(); }, [load]);
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  async function pickReceipt(fromCamera: boolean) {
    const perm = fromCamera ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert("Permission needed", fromCamera ? "Camera access is required." : "Photo library access is required."); return; }
    const result = fromCamera ? await ImagePicker.launchCameraAsync({ quality: 0.6 }) : await ImagePicker.launchImageLibraryAsync({ quality: 0.6 });
    if (result.canceled || !result.assets?.length) return;
    setDraft((d) => d && { ...d, receiptUri: result.assets[0].uri });
  }

  async function addExpense() {
    if (!draft || saving || !fleet.ready) return;
    const amount = parseFloat(draft.amount);
    if (Number.isNaN(amount) || amount <= 0) { Alert.alert("Missing details", "A valid amount is required."); return; }
    if (!profile?.id) { Alert.alert("Not ready", "Your profile is still loading — please try again."); return; }
    setSaving(true);
    try {
      await fleet.addEquipmentExpense({
        equipmentId: id,
        loggedBy: profile.id,
        category: draft.category,
        supplierName: draft.supplier_name.trim() || null,
        description: draft.description.trim() || null,
        invoiceNumber: draft.invoice_number.trim() || null,
        expenseDate: draft.expense_date.trim() || null,
        amount,
        gstAmount: parseFloat(draft.gst_amount) || 0,
        receipt: draft.receiptUri ? { sourceUri: draft.receiptUri, ext: "jpg" } : null,
      });
      setDraft(null);
      await load();
    } catch (e) {
      Alert.alert("Couldn't save", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setSaving(false);
    }
  }

  function confirmRemove(ex: EquipmentExpense) {
    Alert.alert("Remove expense", "This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: async () => { await fleet.removeEquipmentExpense({ id: ex.id, receiptStoragePath: ex.receipt_storage_path }); await load(); } },
    ]);
  }
  async function viewReceipt(ex: EquipmentExpense) {
    if (!ex.receipt_storage_path) return;
    const url = await getEquipmentReceiptSignedUrl(ex.receipt_storage_path);
    if (url) Linking.openURL(url);
    else Alert.alert("Receipt unavailable", "It may still be uploading, or you're offline.");
  }

  if (loading) return <View style={styles.center}><Stack.Screen options={{ title: "Equipment" }} /><ActivityIndicator size="large" color={colors.blue600} /></View>;
  if (!equipment) return <View style={styles.center}><Stack.Screen options={{ title: "Equipment" }} /><Text style={styles.muted}>Equipment not found.</Text></View>;

  const cost = computeEquipmentCost(equipment);
  const expenseTotal = expenses.reduce((s, e) => s + Number(e.amount ?? 0), 0);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.blue600} />}>
      <Stack.Screen options={{ title: equipment.name }} />

      <Text style={styles.name}>{equipment.name}</Text>
      <Text style={styles.sub}>
        {equipment.category}{equipment.registration ? ` · ${equipment.registration}` : ""}
        {equipment.assigned_profile?.full_name ? ` · ${equipment.assigned_profile.full_name}` : " · Unassigned"}
      </Text>

      <Text style={styles.section}>Running cost (est.)</Text>
      <View style={styles.card}>
        <CostRow label="Depreciation / yr" amount={cost.annualDepreciation} />
        <CostRow label="Fixed costs / yr" amount={cost.annualFixedCost} />
        <CostRow label="Fuel / yr" amount={cost.annualFuelCost} />
        <View style={[styles.costRow, styles.totalRow]}>
          <Text style={styles.totalLabel}>Total / hr</Text>
          <MoneyText amount={cost.costPerHour} style={styles.totalValue} />
        </View>
      </View>

      <View style={styles.sectionHead}>
        <Text style={styles.section}>Expenses &amp; service history</Text>
        <TouchableOpacity onPress={() => setDraft({ ...emptyDraft })} style={styles.addBtn}>
          <Ionicons name="add" size={16} color={colors.blue600} /><Text style={styles.addText}>Add</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.card}>
        {expenses.length === 0 ? <Text style={styles.empty}>No expenses logged.</Text> : expenses.map((ex) => (
          <TouchableOpacity key={ex.id} style={styles.expRow} onLongPress={() => confirmRemove(ex)}>
            <View style={{ flex: 1 }}>
              <Text style={styles.expName}>{ex.supplier_name || ex.category}</Text>
              <Text style={styles.expMeta}>
                {ex.category.replace(/_/g, " ")}{ex.expense_date ? ` · ${new Date(ex.expense_date).toLocaleDateString("en-AU")}` : ""}{ex.description ? ` · ${ex.description}` : ""}
              </Text>
              {ex.receipt_storage_path && (
                <TouchableOpacity onPress={() => viewReceipt(ex)} style={styles.receiptLink} hitSlop={8}>
                  <Ionicons name="document-attach-outline" size={13} color={colors.blue600} />
                  <Text style={styles.receiptLinkText}>View receipt</Text>
                </TouchableOpacity>
              )}
            </View>
            <MoneyText amount={ex.amount} style={styles.expAmount} />
          </TouchableOpacity>
        ))}
        {expenses.length > 0 && (
          <View style={[styles.costRow, styles.totalRow]}><Text style={styles.totalLabel}>Total logged</Text><MoneyText amount={expenseTotal} style={styles.totalValue} /></View>
        )}
      </View>
      {expenses.length > 0 && <Text style={styles.hint}>Long-press an expense to remove it.</Text>}

      <View style={styles.sectionHead}>
        <Text style={styles.section}>Usage log</Text>
        {!usageDraft && (
          <TouchableOpacity onPress={() => setUsageDraft({ usageDate: "", hours: "", notes: "" })} style={styles.addBtn}>
            <Ionicons name="add" size={16} color={colors.blue600} /><Text style={styles.addText}>Add</Text>
          </TouchableOpacity>
        )}
      </View>
      <View style={styles.card}>
        {usageDraft ? (
          <View>
            <View style={styles.twoCol}>
              <View style={{ flex: 1 }}><Field label="Date (YYYY-MM-DD)" value={usageDraft.usageDate} onChange={(v) => setUsageDraft((d) => d && { ...d, usageDate: v })} /></View>
              <View style={{ flex: 1 }}><Field label="Hours" value={usageDraft.hours} onChange={(v) => setUsageDraft((d) => d && { ...d, hours: v })} num /></View>
            </View>
            <Field label="Notes (optional)" value={usageDraft.notes} onChange={(v) => setUsageDraft((d) => d && { ...d, notes: v })} />
            <View style={styles.actions}>
              <TouchableOpacity style={styles.cancel} onPress={() => setUsageDraft(null)} disabled={usageSaving}><Text style={styles.cancelText}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity style={styles.saveBtn} onPress={addUsage} disabled={usageSaving}><Text style={styles.saveText}>{usageSaving ? "…" : "Add"}</Text></TouchableOpacity>
            </View>
          </View>
        ) : usage.length === 0 ? <Text style={styles.empty}>No usage logged.</Text> : (
          <>
            {usage.map((u) => (
              <TouchableOpacity key={u.id} style={styles.expRow} onLongPress={() => confirmRemoveUsage(u)}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.expName}>{u.hours}h{u.job_id ? " · on a job" : ""}</Text>
                  <Text style={styles.expMeta}>{u.usage_date ? new Date(u.usage_date).toLocaleDateString("en-AU") : "No date"}{u.notes ? ` · ${u.notes}` : ""}</Text>
                </View>
              </TouchableOpacity>
            ))}
            <View style={[styles.costRow, styles.totalRow]}><Text style={styles.totalLabel}>Total hours</Text><Text style={styles.totalValue}>{usage.reduce((s, u) => s + Number(u.hours ?? 0), 0)}h</Text></View>
          </>
        )}
      </View>
      {usage.length > 0 && !usageDraft && <Text style={styles.hint}>Long-press a usage entry to remove it.</Text>}

      <Text style={styles.section}>Documents</Text>
      <View style={styles.card}>
        {documents.length === 0 ? (
          <Text style={styles.empty}>No documents. Registration, insurance &amp; compliance files are uploaded on the web.</Text>
        ) : (
          documents.map((doc) => (
            <TouchableOpacity key={doc.id} style={styles.docRow} onPress={() => openDocument(doc)} disabled={openingDocId === doc.id}>
              <View style={styles.docIcon}>
                {openingDocId === doc.id ? <ActivityIndicator size="small" color={colors.blue600} /> : <Text style={styles.docIconText}>{extLabel(doc.file_name)}</Text>}
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.docName} numberOfLines={1}>{doc.file_name}</Text>
                <Text style={styles.expMeta}>
                  {[formatBytes(doc.file_size), doc.profiles?.full_name, new Date(doc.created_at).toLocaleDateString("en-AU")].filter(Boolean).join(" · ")}
                </Text>
              </View>
              <Ionicons name="open-outline" size={18} color={colors.blue600} />
            </TouchableOpacity>
          ))
        )}
      </View>

      <Modal visible={!!draft} transparent animationType="slide" onRequestClose={() => !saving && setDraft(null)}>
        <View style={styles.overlay}>
          <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheet} keyboardShouldPersistTaps="handled">
            <Text style={styles.sheetTitle}>Log expense</Text>
            <Text style={styles.fieldLabel}>Category</Text>
            <View style={styles.catRow}>
              {CATEGORIES.map((c) => (
                <TouchableOpacity key={c} style={[styles.catChip, draft?.category === c && styles.catChipActive]} onPress={() => setDraft((d) => d && { ...d, category: c })}>
                  <Text style={[styles.catChipText, draft?.category === c && styles.catChipTextActive]}>{c}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Field label="Supplier (optional)" value={draft?.supplier_name ?? ""} onChange={(v) => setDraft((d) => d && { ...d, supplier_name: v })} />
            <Field label="Description (optional)" value={draft?.description ?? ""} onChange={(v) => setDraft((d) => d && { ...d, description: v })} />
            <View style={styles.twoCol}>
              <View style={{ flex: 1 }}><Field label="Invoice # (optional)" value={draft?.invoice_number ?? ""} onChange={(v) => setDraft((d) => d && { ...d, invoice_number: v })} /></View>
              <View style={{ flex: 1 }}><Field label="Date (YYYY-MM-DD)" value={draft?.expense_date ?? ""} onChange={(v) => setDraft((d) => d && { ...d, expense_date: v })} /></View>
            </View>
            <View style={styles.twoCol}>
              <View style={{ flex: 1 }}><Field label="Amount (ex GST)" value={draft?.amount ?? ""} onChange={(v) => setDraft((d) => d && { ...d, amount: v })} num /></View>
              <View style={{ flex: 1 }}><Field label="GST" value={draft?.gst_amount ?? ""} onChange={(v) => setDraft((d) => d && { ...d, gst_amount: v })} num /></View>
            </View>
            <Text style={styles.fieldLabel}>Receipt (optional)</Text>
            {draft?.receiptUri ? (
              <View style={styles.receiptChosen}>
                <Ionicons name="checkmark-circle" size={16} color={colors.green600} />
                <Text style={styles.receiptChosenText}>Receipt attached</Text>
                <TouchableOpacity onPress={() => setDraft((d) => d && { ...d, receiptUri: null })} hitSlop={8}><Text style={styles.receiptRemove}>Remove</Text></TouchableOpacity>
              </View>
            ) : (
              <View style={styles.twoCol}>
                <TouchableOpacity style={styles.receiptBtn} onPress={() => pickReceipt(true)}><Ionicons name="camera-outline" size={16} color={colors.blue600} /><Text style={styles.receiptBtnText}>Camera</Text></TouchableOpacity>
                <TouchableOpacity style={styles.receiptBtn} onPress={() => pickReceipt(false)}><Ionicons name="image-outline" size={16} color={colors.blue600} /><Text style={styles.receiptBtnText}>Gallery</Text></TouchableOpacity>
              </View>
            )}
            <View style={styles.actions}>
              <TouchableOpacity style={styles.cancel} onPress={() => setDraft(null)} disabled={saving}><Text style={styles.cancelText}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity style={styles.saveBtn} onPress={addExpense} disabled={saving}><Text style={styles.saveText}>{saving ? "…" : "Add"}</Text></TouchableOpacity>
            </View>
          </ScrollView>
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
function CostRow({ label, amount }: { label: string; amount: number }) {
  return (
    <View style={styles.costRow}>
      <Text style={styles.costLabel}>{label}</Text>
      <MoneyText amount={amount} style={styles.costValue} />
    </View>
  );
}
function formatBytes(bytes: number | null) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function extLabel(fileName: string) {
  const ext = fileName.split(".").pop()?.toUpperCase() ?? "";
  return ext.length <= 4 ? ext : "FILE";
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 40 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  muted: { fontSize: 13, color: colors.slate500 },
  name: { fontSize: 20, fontWeight: "800", color: colors.slate900 },
  sub: { fontSize: 13, color: colors.slate500, marginTop: 2, textTransform: "capitalize" },
  section: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginTop: 16, marginBottom: 8, marginLeft: 4 },
  sectionHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  addBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
  addText: { fontSize: 13, color: colors.blue600, fontWeight: "600" },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12 },
  costRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 6 },
  costLabel: { fontSize: 14, color: colors.slate500 },
  costValue: { fontSize: 14, fontWeight: "600", color: colors.slate700 },
  totalRow: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: 4, paddingTop: 10 },
  totalLabel: { fontSize: 14, fontWeight: "800", color: colors.slate900 },
  totalValue: { fontSize: 16, fontWeight: "800", color: colors.slate900 },
  empty: { fontSize: 13, color: colors.slate400, paddingVertical: 8, textAlign: "center" },
  expRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.slate100 },
  expName: { fontSize: 14, fontWeight: "600", color: colors.slate900 },
  expMeta: { fontSize: 12, color: colors.slate500, marginTop: 1, textTransform: "capitalize" },
  expAmount: { fontSize: 14, fontWeight: "700", color: colors.slate900 },
  receiptLink: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  receiptLinkText: { fontSize: 12, color: colors.blue600, fontWeight: "600" },
  docRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.slate100 },
  docIcon: { width: 36, height: 36, borderRadius: 8, backgroundColor: colors.blue100, alignItems: "center", justifyContent: "center" },
  docIconText: { fontSize: 10, fontWeight: "700", color: colors.blue600 },
  docName: { fontSize: 14, fontWeight: "600", color: colors.slate900 },
  hint: { fontSize: 11, color: colors.slate400, marginLeft: 4, marginTop: 6 },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheetScroll: { maxHeight: "88%", flexGrow: 0 },
  sheet: { backgroundColor: colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, paddingBottom: 28 },
  sheetTitle: { fontSize: 16, fontWeight: "800", color: colors.slate900, marginBottom: 12 },
  field: { marginBottom: 12 },
  fieldLabel: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginBottom: 6 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, backgroundColor: colors.bg, color: colors.slate900 },
  twoCol: { flexDirection: "row", gap: 12 },
  catRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  catChip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  catChipActive: { backgroundColor: colors.blue600, borderColor: colors.blue600 },
  catChipText: { fontSize: 12, fontWeight: "600", color: colors.slate700, textTransform: "capitalize" },
  catChipTextActive: { color: "#fff" },
  receiptBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.blue100, backgroundColor: colors.blue100 },
  receiptBtnText: { fontSize: 13, fontWeight: "600", color: colors.blue600 },
  receiptChosen: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 },
  receiptChosenText: { fontSize: 13, color: colors.slate700, fontWeight: "600", flex: 1 },
  receiptRemove: { fontSize: 13, color: colors.red600, fontWeight: "600" },
  actions: { flexDirection: "row", gap: 10, marginTop: 8 },
  cancel: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.bg, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  cancelText: { color: colors.slate700, fontWeight: "600", fontSize: 14 },
  saveBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.blue600, alignItems: "center" },
  saveText: { color: "#fff", fontWeight: "700", fontSize: 14 },
});
