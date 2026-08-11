import { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, TouchableOpacity, Modal, TextInput, Alert, RefreshControl } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { colors } from "../../../lib/theme";
import { MoneyText } from "../../../design/components/MoneyText";
import { ScreenError } from "../../../design/components/ScreenError";
import { openExternalUrl } from "../../../lib/open-external-url";
import { getJobBilling, getJobEquipment, getJobCostCentres, getReceiptSignedUrl, type JobBilling, type JobEquipment, type JobExpense, type JobCostCentre } from "../../../lib/data/reads/jobBilling";
import { useJobBilling } from "../../../lib/data/hooks/useJobBilling";
import { useFleet } from "../../../lib/data/hooks/useFleet";
import { useAuth } from "../../../lib/auth-context";
import { useIsAdmin } from "../../../design/guards/useRole";
import type { ExpenseCategory } from "../../../lib/data/repositories/jobBilling";

interface Draft { name: string; quantity: string; unit_price: string; description: string }
interface EquipDraft { equipmentId: string; usage_date: string; hours: string; notes: string }
interface ExpenseDraft {
  supplier_name: string;
  category: ExpenseCategory;
  description: string;
  invoice_number: string;
  invoice_date: string; // YYYY-MM-DD (optional)
  amount: string;
  gst_amount: string;
  costCenterId: string | null;
  receiptUri: string | null;
}

const EXPENSE_CATEGORIES: { value: ExpenseCategory; label: string }[] = [
  { value: "materials", label: "Materials" },
  { value: "subcontractor", label: "Subcontractor" },
  { value: "equipment_hire", label: "Equipment Hire" },
  { value: "other", label: "Other" },
];
const CATEGORY_LABELS: Record<string, string> = Object.fromEntries(EXPENSE_CATEGORIES.map((c) => [c.value, c.label]));

const emptyExpense: ExpenseDraft = {
  supplier_name: "", category: "materials", description: "", invoice_number: "", invoice_date: "", amount: "", gst_amount: "", costCenterId: null, receiptUri: null,
};

export default function JobBillingScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const billing = useJobBilling();
  const fleet = useFleet();
  const router = useRouter();
  const isAdmin = useIsAdmin();
  const { profile } = useAuth();
  const [data, setData] = useState<JobBilling | null>(null);
  const [equipment, setEquipment] = useState<JobEquipment | null>(null);
  const [costCentres, setCostCentres] = useState<JobCostCentre[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [expense, setExpense] = useState<ExpenseDraft | null>(null);
  const [savingExpense, setSavingExpense] = useState(false);
  const [equipDraft, setEquipDraft] = useState<EquipDraft | null>(null);
  const [savingEquip, setSavingEquip] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // These three reads now THROW on a failed query, and Promise.all means any one
  // of them rejecting skips setLoading(false) entirely — a permanent spinner on
  // the screen where the money is entered. The finally also clears the refresh
  // control, which a pull-to-refresh failure would otherwise leave spinning.
  const load = useCallback(async () => {
    try {
      setError(null);
      const [b, e, cc] = await Promise.all([getJobBilling(id), getJobEquipment(id), getJobCostCentres(id)]);
      setCostCentres(cc);
      setData(b);
      setEquipment(e);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [id]);
  useEffect(() => { void load(); }, [load]);
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  const lineTotal = data ? data.lineItems.reduce((s, i) => s + Number(i.total ?? 0), 0) : 0;
  const expenseTotal = data ? data.expenses.reduce((s, e) => s + Number(e.amount ?? 0), 0) : 0;
  const equipHours = equipment ? equipment.usage.reduce((s, u) => s + Number(u.hours), 0) : 0;
  const equipCost = equipment ? equipment.usage.reduce((s, u) => s + Number(u.total_cost), 0) : 0;

  async function addEquipmentUsage() {
    if (!equipDraft || savingEquip || !fleet.ready) return;
    const hours = parseFloat(equipDraft.hours);
    if (!equipDraft.equipmentId || Number.isNaN(hours) || hours <= 0) { Alert.alert("Missing details", "Choose equipment and enter hours greater than zero."); return; }
    if (!profile?.id) { Alert.alert("Not ready", "Your profile is still loading — please try again."); return; }
    setSavingEquip(true);
    try {
      await fleet.addEquipmentUsage({
        equipmentId: equipDraft.equipmentId,
        loggedBy: profile.id,
        jobId: id,
        usageDate: equipDraft.usage_date.trim() || null,
        hours,
        notes: equipDraft.notes.trim() || null,
      });
      setEquipDraft(null);
      await load();
    } catch (e) {
      Alert.alert("Couldn't log usage", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setSavingEquip(false);
    }
  }

  function confirmRemoveEquipment(usageId: string) {
    Alert.alert("Remove equipment usage", "This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: async () => { await fleet.removeEquipmentUsage(usageId); await load(); } },
    ]);
  }

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
    } catch (e) {
      Alert.alert("Couldn't add line item", e instanceof Error ? e.message : "Please try again.");
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

  async function pickReceipt(fromCamera: boolean) {
    const perm = fromCamera ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert("Permission needed", fromCamera ? "Camera access is required." : "Photo library access is required."); return; }
    const result = fromCamera ? await ImagePicker.launchCameraAsync({ quality: 0.6 }) : await ImagePicker.launchImageLibraryAsync({ quality: 0.6 });
    if (result.canceled || !result.assets?.length) return;
    setExpense((d) => d && { ...d, receiptUri: result.assets[0].uri });
  }

  async function addExpense() {
    if (!expense || savingExpense || !billing.ready) return;
    const amount = parseFloat(expense.amount);
    if (!expense.supplier_name.trim() || Number.isNaN(amount) || amount <= 0) { Alert.alert("Missing details", "Supplier and a valid amount are required."); return; }
    if (!profile?.id) { Alert.alert("Not ready", "Your profile is still loading — please try again."); return; }
    setSavingExpense(true);
    try {
      await billing.addExpense({
        jobId: id,
        enteredBy: profile.id,
        supplierName: expense.supplier_name.trim(),
        category: expense.category,
        description: expense.description.trim() || null,
        invoiceNumber: expense.invoice_number.trim() || null,
        invoiceDate: expense.invoice_date.trim() || null,
        amount,
        gstAmount: parseFloat(expense.gst_amount) || 0,
        costCenterId: expense.costCenterId,
        receipt: expense.receiptUri ? { sourceUri: expense.receiptUri, ext: "jpg" } : null,
      });
      setExpense(null);
      await load();
    } catch (e) {
      Alert.alert("Couldn't save expense", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setSavingExpense(false);
    }
  }

  function confirmRemoveExpense(e: JobExpense) {
    Alert.alert("Remove expense", "This cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      { text: "Remove", style: "destructive", onPress: async () => { await billing.removeExpense({ id: e.id, receiptStoragePath: e.receipt_storage_path }); await load(); } },
    ]);
  }

  async function viewReceipt(e: JobExpense) {
    if (!e.receipt_storage_path) return;
    // getReceiptSignedUrl runs its result through unwrap(), so a Storage or RLS
    // failure THROWS. This function's only caller is an onPress arrow, which
    // returns the promise into a handler that discards it — so the throw
    // escaped as an unhandled rejection and the tap did nothing at all. ESLint
    // cannot see it: the arrow returns the promise rather than floating it as a
    // statement, and the `void` on the line below made the function read as
    // handled while the failure one line above still escaped.
    try {
      const url = await getReceiptSignedUrl(e.receipt_storage_path);
      if (url) void openExternalUrl(url, "the receipt");
      else Alert.alert("Receipt unavailable", "The receipt can't be opened right now (it may still be uploading, or you're offline).");
    } catch (err) {
      Alert.alert("Receipt unavailable", err instanceof Error && err.message ? err.message : "Please try again.");
    }
  }

  if (loading) return <View style={styles.center}><Stack.Screen options={{ title: "Billing" }} /><ActivityIndicator size="large" color={colors.blue600} /></View>;
  // Checked BEFORE the !data branch: a read that failed must never be reported
  // as "Job not found." on the billing screen, where believing the job is gone
  // is how the same line items get entered twice.
  if (error) return <View style={styles.container}><Stack.Screen options={{ title: "Billing" }} /><ScreenError error={error} onRetry={() => { setLoading(true); void load(); }} /></View>;
  if (!data) return <View style={styles.center}><Stack.Screen options={{ title: "Billing" }} /><Text style={styles.muted}>Job not found.</Text></View>;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.blue600} />}>
      <Stack.Screen options={{ title: data.jobNumber ? `#${data.jobNumber} Billing` : "Billing" }} />

      {isAdmin && (
        <TouchableOpacity style={styles.costingBtn} onPress={() => router.push(`/job/${id}/costing`)} accessibilityLabel="Job costing and margin">
          <Ionicons name="stats-chart-outline" size={16} color={colors.blue600} />
          <Text style={styles.costingBtnText}>Job costing &amp; margin</Text>
          <Ionicons name="chevron-forward" size={16} color={colors.blue600} />
        </TouchableOpacity>
      )}

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

      <View style={styles.sectionHead}>
        <Text style={styles.section}>Expenses</Text>
        <TouchableOpacity onPress={() => setExpense({ ...emptyExpense })} style={styles.addBtn}>
          <Ionicons name="add" size={16} color={colors.blue600} /><Text style={styles.addText}>Add</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.card}>
        {data.expenses.length === 0 ? <Text style={styles.empty}>No expenses.</Text> : data.expenses.map((e) => (
          <TouchableOpacity key={e.id} style={styles.lineRow} onLongPress={() => confirmRemoveExpense(e)}>
            <View style={{ flex: 1 }}>
              <Text style={styles.lineName}>{e.supplier_name}</Text>
              <Text style={styles.lineMeta}>
                {CATEGORY_LABELS[e.category] ?? e.category}
                {e.invoice_number ? ` · Inv #${e.invoice_number}` : ""}
                {e.description ? ` · ${e.description}` : ""}
                {e.cost_center_id ? ` · ${costCentres.find((c) => c.id === e.cost_center_id)?.name ?? "Stage"}` : ""}
              </Text>
              {e.receipt_storage_path && (
                <TouchableOpacity onPress={() => viewReceipt(e)} style={styles.receiptLink} hitSlop={8}>
                  <Ionicons name="document-attach-outline" size={13} color={colors.blue600} />
                  <Text style={styles.receiptLinkText}>View receipt</Text>
                </TouchableOpacity>
              )}
            </View>
            <MoneyText amount={e.amount} style={styles.lineTotal} />
          </TouchableOpacity>
        ))}
        {data.expenses.length > 0 && (
          <View style={styles.subtotalRow}><Text style={styles.subtotalLabel}>Expenses total</Text><MoneyText amount={expenseTotal} style={styles.subtotalValue} /></View>
        )}
      </View>
      {data.expenses.length > 0 && <Text style={styles.hint}>Long-press an expense to remove it.</Text>}

      <View style={styles.sectionHead}>
        <Text style={styles.section}>Equipment usage</Text>
        <TouchableOpacity
          onPress={() => setEquipDraft({ equipmentId: equipment?.options[0]?.id ?? "", usage_date: "", hours: "", notes: "" })}
          style={styles.addBtn}
        >
          <Ionicons name="add" size={16} color={colors.blue600} /><Text style={styles.addText}>Add</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.card}>
        {!equipment || equipment.usage.length === 0 ? (
          <Text style={styles.empty}>No equipment logged.</Text>
        ) : (
          equipment.usage.map((u) => (
            <TouchableOpacity key={u.id} style={styles.lineRow} onLongPress={() => confirmRemoveEquipment(u.id)}>
              <View style={{ flex: 1 }}>
                <Text style={styles.lineName}>{u.equipment_name}</Text>
                <Text style={styles.lineMeta}>
                  {u.hours.toFixed(1)}h{u.usage_date ? ` · ${u.usage_date}` : ""}{u.notes ? ` · ${u.notes}` : ""}
                </Text>
              </View>
              <MoneyText amount={u.total_cost} style={styles.lineTotal} />
            </TouchableOpacity>
          ))
        )}
        {equipment && equipment.usage.length > 0 && (
          <View style={styles.subtotalRow}>
            <Text style={styles.subtotalLabel}>{equipHours.toFixed(1)}h logged</Text>
            <MoneyText amount={equipCost} style={styles.subtotalValue} />
          </View>
        )}
      </View>
      {equipment && equipment.usage.length > 0 && <Text style={styles.hint}>Long-press an entry to remove it.</Text>}

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

      <Text style={styles.footnote}>PO editing and PDF receipts are managed on the web dashboard.</Text>

      {/* Add line item */}
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

      {/* Add expense */}
      <Modal visible={!!expense} transparent animationType="slide" onRequestClose={() => !savingExpense && setExpense(null)}>
        <View style={styles.overlay}>
          <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheet} keyboardShouldPersistTaps="handled">
            <Text style={styles.sheetTitle}>Add expense</Text>
            <Field label="Supplier" value={expense?.supplier_name ?? ""} onChange={(v) => setExpense((d) => d && { ...d, supplier_name: v })} />

            <Text style={styles.fieldLabel}>Category</Text>
            <View style={styles.catRow}>
              {EXPENSE_CATEGORIES.map((c) => (
                <TouchableOpacity
                  key={c.value}
                  style={[styles.catChip, expense?.category === c.value && styles.catChipActive]}
                  onPress={() => setExpense((d) => d && { ...d, category: c.value })}
                >
                  <Text style={[styles.catChipText, expense?.category === c.value && styles.catChipTextActive]}>{c.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <Field label="Description (optional)" value={expense?.description ?? ""} onChange={(v) => setExpense((d) => d && { ...d, description: v })} />
            <View style={styles.twoCol}>
              <View style={{ flex: 1 }}><Field label="Invoice # (optional)" value={expense?.invoice_number ?? ""} onChange={(v) => setExpense((d) => d && { ...d, invoice_number: v })} /></View>
              <View style={{ flex: 1 }}><Field label="Invoice date (YYYY-MM-DD)" value={expense?.invoice_date ?? ""} onChange={(v) => setExpense((d) => d && { ...d, invoice_date: v })} /></View>
            </View>
            <View style={styles.twoCol}>
              <View style={{ flex: 1 }}><Field label="Amount (ex GST)" value={expense?.amount ?? ""} onChange={(v) => setExpense((d) => d && { ...d, amount: v })} num /></View>
              <View style={{ flex: 1 }}><Field label="GST" value={expense?.gst_amount ?? ""} onChange={(v) => setExpense((d) => d && { ...d, gst_amount: v })} num /></View>
            </View>

            {/* Allocate the spend to a PO cost-centre stage, the same stages the
                Time tab allocates hours to. Only shown when the job has POs. */}
            {costCentres.length > 0 && (
              <>
                <Text style={styles.fieldLabel}>Cost centre</Text>
                <View style={styles.catRow}>
                  <TouchableOpacity
                    style={[styles.catChip, !expense?.costCenterId && styles.catChipActive]}
                    onPress={() => setExpense((d) => d && { ...d, costCenterId: null })}
                  >
                    <Text style={[styles.catChipText, !expense?.costCenterId && styles.catChipTextActive]}>Unassigned</Text>
                  </TouchableOpacity>
                  {costCentres.map((cc) => (
                    <TouchableOpacity
                      key={cc.id}
                      style={[styles.catChip, expense?.costCenterId === cc.id && styles.catChipActive]}
                      onPress={() => setExpense((d) => d && { ...d, costCenterId: cc.id })}
                    >
                      <Text style={[styles.catChipText, expense?.costCenterId === cc.id && styles.catChipTextActive]} numberOfLines={1}>
                        {cc.name}{cc.po_number ? ` · PO #${cc.po_number}` : ""}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            )}

            <Text style={styles.fieldLabel}>Receipt (optional)</Text>
            {expense?.receiptUri ? (
              <View style={styles.receiptChosen}>
                <Ionicons name="checkmark-circle" size={16} color={colors.green600} />
                <Text style={styles.receiptChosenText}>Receipt attached</Text>
                <TouchableOpacity onPress={() => setExpense((d) => d && { ...d, receiptUri: null })} hitSlop={8}><Text style={styles.receiptRemove}>Remove</Text></TouchableOpacity>
              </View>
            ) : (
              <View style={styles.twoCol}>
                <TouchableOpacity style={styles.receiptBtn} onPress={() => pickReceipt(true)}><Ionicons name="camera-outline" size={16} color={colors.blue600} /><Text style={styles.receiptBtnText}>Camera</Text></TouchableOpacity>
                <TouchableOpacity style={styles.receiptBtn} onPress={() => pickReceipt(false)}><Ionicons name="image-outline" size={16} color={colors.blue600} /><Text style={styles.receiptBtnText}>Gallery</Text></TouchableOpacity>
              </View>
            )}

            <View style={styles.actions}>
              <TouchableOpacity style={styles.cancel} onPress={() => setExpense(null)} disabled={savingExpense}><Text style={styles.cancelText}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity style={styles.saveBtn} onPress={addExpense} disabled={savingExpense}><Text style={styles.saveText}>{savingExpense ? "…" : "Add"}</Text></TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </Modal>

      {/* Log equipment usage */}
      <Modal visible={!!equipDraft} transparent animationType="slide" onRequestClose={() => !savingEquip && setEquipDraft(null)}>
        <View style={styles.overlay}>
          <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheet} keyboardShouldPersistTaps="handled">
            <Text style={styles.sheetTitle}>Log equipment usage</Text>
            {!equipment || equipment.options.length === 0 ? (
              <Text style={styles.muted}>No active equipment set up yet — add vehicles/machinery under Fleet first.</Text>
            ) : (
              <>
                <Text style={styles.fieldLabel}>Equipment</Text>
                <View style={styles.catRow}>
                  {equipment.options.map((eq) => (
                    <TouchableOpacity
                      key={eq.id}
                      style={[styles.catChip, equipDraft?.equipmentId === eq.id && styles.catChipActive]}
                      onPress={() => setEquipDraft((d) => d && { ...d, equipmentId: eq.id })}
                    >
                      <Text style={[styles.catChipText, equipDraft?.equipmentId === eq.id && styles.catChipTextActive]}>{eq.name}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <View style={styles.twoCol}>
                  <View style={{ flex: 1 }}><Field label="Date (YYYY-MM-DD)" value={equipDraft?.usage_date ?? ""} onChange={(v) => setEquipDraft((d) => d && { ...d, usage_date: v })} /></View>
                  <View style={{ flex: 1 }}><Field label="Hours" value={equipDraft?.hours ?? ""} onChange={(v) => setEquipDraft((d) => d && { ...d, hours: v })} num /></View>
                </View>
                <Field label="Notes (optional)" value={equipDraft?.notes ?? ""} onChange={(v) => setEquipDraft((d) => d && { ...d, notes: v })} />
              </>
            )}
            <View style={styles.actions}>
              <TouchableOpacity style={styles.cancel} onPress={() => setEquipDraft(null)} disabled={savingEquip}><Text style={styles.cancelText}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity style={styles.saveBtn} onPress={addEquipmentUsage} disabled={savingEquip || !equipment || equipment.options.length === 0}><Text style={styles.saveText}>{savingEquip ? "…" : "Add"}</Text></TouchableOpacity>
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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 40, gap: 6 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  muted: { fontSize: 13, color: colors.slate500 },
  section: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginTop: 14, marginBottom: 8, marginLeft: 4 },
  sectionHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 8 },
  addBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
  addText: { fontSize: 13, color: colors.blue600, fontWeight: "600" },
  costingBtn: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.blue100, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, marginTop: 10 },
  costingBtnText: { flex: 1, fontSize: 14, fontWeight: "700", color: colors.blue600 },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12, gap: 2 },
  empty: { fontSize: 13, color: colors.slate400, paddingVertical: 8, textAlign: "center" },
  lineRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.slate100 },
  lineName: { fontSize: 14, fontWeight: "600", color: colors.slate900 },
  lineMeta: { fontSize: 12, color: colors.slate500, marginTop: 1 },
  lineMetaMoney: { fontSize: 12, color: colors.slate500 },
  lineTotal: { fontSize: 14, fontWeight: "700", color: colors.slate900, width: 76, textAlign: "right" },
  receiptLink: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  receiptLinkText: { fontSize: 12, color: colors.blue600, fontWeight: "600" },
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
  catChipText: { fontSize: 12, fontWeight: "600", color: colors.slate700 },
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
