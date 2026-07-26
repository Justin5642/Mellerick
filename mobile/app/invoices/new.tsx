import { useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, TextInput, TouchableOpacity, Alert, Platform } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import DateTimePicker, { type DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { useFinance } from "../../lib/data/hooks/useFinance";
import { CustomerPicker } from "../../components/finance/customer-picker";
import { localDateKey } from "../../lib/date";
import { LineItemsEditor, newItem, type EditableItem } from "../../components/finance/line-items-editor";
import { getInvoiceJobPrefill } from "../../lib/data/reads/finance";
import type { CustomerListRow } from "../../lib/data/reads/customers";

interface UnbilledVariation { id: string; name: string; description: string; unitPrice: number }

export default function NewInvoiceScreen() {
  const router = useRouter();
  const finance = useFinance();
  const { jobId } = useLocalSearchParams<{ jobId?: string }>();
  const [customer, setCustomer] = useState<CustomerListRow | null>(null);
  const [pickCustomer, setPickCustomer] = useState(false);
  const [title, setTitle] = useState("");
  const [workDescription, setWorkDescription] = useState("");
  const [dueDate, setDueDate] = useState<Date | null>(null);
  const [showDate, setShowDate] = useState(false);
  const [items, setItems] = useState<EditableItem[]>([newItem()]);
  const [notes, setNotes] = useState("");
  const [unbilled, setUnbilled] = useState<UnbilledVariation[]>([]);
  const [saving, setSaving] = useState(false);
  const [prefilling, setPrefilling] = useState(!!jobId);

  // Create-from-job: prefill customer, title, work description, line items, and
  // load the job's unbilled approved variations to optionally add.
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    (async () => {
      const p = await getInvoiceJobPrefill(jobId);
      if (cancelled || !p) { setPrefilling(false); return; }
      setCustomer({ id: p.customerId, name: p.customerName ?? "Customer" } as CustomerListRow);
      setTitle(p.title);
      setWorkDescription(p.workDescription ?? "");
      if (p.items.length > 0) {
        setItems(p.items.map((i) => newItem({ name: i.name, description: i.description ?? "", quantity: String(i.quantity), unit_price: String(i.unitPrice) })));
      }
      setUnbilled(p.unbilledVariations);
      setPrefilling(false);
    })();
    return () => { cancelled = true; };
  }, [jobId]);

  function onDateChange(event: DateTimePickerEvent, selected?: Date) {
    setShowDate(Platform.OS === "ios");
    if (event.type === "set" && selected) setDueDate(selected);
  }

  function addVariation(v: UnbilledVariation) {
    setItems((prev) => {
      const blankOnly = prev.length === 1 && !prev[0].name.trim() && (parseFloat(prev[0].unit_price) || 0) === 0;
      const base = blankOnly ? [] : prev;
      return [...base, newItem({ name: v.name, description: v.description, quantity: "1", unit_price: String(v.unitPrice), variationId: v.id })];
    });
  }

  const addedVariationIds = new Set(items.map((i) => i.variationId).filter(Boolean));
  const availableVariations = unbilled.filter((v) => !addedVariationIds.has(v.id));

  async function save() {
    if (saving || !finance.ready) return;
    const named = items.filter((i) => i.name.trim());
    const lineItems = named.map((i) => ({ name: i.name.trim(), description: i.description.trim() || null, quantity: parseFloat(i.quantity) || 0, unitPrice: parseFloat(i.unit_price) || 0 }));
    if (!customer) { Alert.alert("Customer required", "Select a customer for this invoice."); return; }
    if (!title.trim()) { Alert.alert("Title required", "Enter an invoice title."); return; }
    if (lineItems.length === 0) { Alert.alert("Line items required", "Add at least one named line item."); return; }
    setSaving(true);
    try {
      // Variations still present as named line items get marked billed; the job
      // clears its ready_to_invoice. Only when creating from a job.
      const markVariationIds = named.map((i) => i.variationId).filter((v): v is string => !!v);
      const { result, synced } = await finance.createInvoice({
        customerId: customer.id,
        jobId: jobId ?? null,
        title: title.trim(),
        dueDateIso: dueDate ? localDateKey(dueDate) : null,
        notes: notes.trim() || null,
        workDescription: workDescription.trim() || null,
        items: lineItems,
        reconcile: jobId ? { markVariationIds } : null,
      });
      if (synced) {
        router.replace(`/invoices/${result}`);
      } else {
        Alert.alert("Saved offline", "The draft invoice is queued and will sync when you're back online.");
        router.back();
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: jobId ? "Invoice from Job" : "New Invoice" }} />

      {prefilling && <Text style={styles.prefill}>Loading job details…</Text>}
      {jobId && !prefilling && <Text style={styles.prefill}>Prefilled from the job — review before creating.</Text>}

      <Text style={styles.label}>Customer</Text>
      <TouchableOpacity style={styles.selector} onPress={() => setPickCustomer(true)}>
        <Text style={[styles.selectorText, !customer && styles.placeholder]}>{customer ? customer.name : "Select customer…"}</Text>
        <Ionicons name="chevron-forward" size={16} color={colors.slate400} />
      </TouchableOpacity>

      <Text style={styles.label}>Title</Text>
      <TextInput style={styles.input} value={title} onChangeText={setTitle} placeholder="e.g. Backflow retest — annual" placeholderTextColor={colors.slate400} />

      <Text style={styles.label}>Due date (optional)</Text>
      <TouchableOpacity style={styles.selector} onPress={() => setShowDate(true)}>
        <Text style={[styles.selectorText, !dueDate && styles.placeholder]}>{dueDate ? dueDate.toLocaleDateString("en-AU") : "No due date"}</Text>
        <Ionicons name="calendar-outline" size={16} color={colors.slate400} />
      </TouchableOpacity>
      {showDate && <DateTimePicker value={dueDate ?? new Date()} mode="date" onChange={onDateChange} />}

      <Text style={[styles.label, { marginTop: 18 }]}>Line items</Text>
      <LineItemsEditor items={items} onChange={setItems} />

      {availableVariations.length > 0 && (
        <View style={styles.varBlock}>
          <Text style={styles.varHead}>Unbilled variations — tap to add</Text>
          <View style={styles.varChips}>
            {availableVariations.map((v) => (
              <TouchableOpacity key={v.id} style={styles.varChip} onPress={() => addVariation(v)}>
                <Ionicons name="add" size={14} color={colors.blue600} />
                <Text style={styles.varChipText} numberOfLines={1}>{v.name} · ${v.unitPrice.toFixed(2)}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}

      {(jobId || workDescription) && (
        <>
          <Text style={[styles.label, { marginTop: 18 }]}>Work carried out (optional)</Text>
          <TextInput style={[styles.input, styles.multiline]} value={workDescription} onChangeText={setWorkDescription} placeholder="Customer-facing description of works" placeholderTextColor={colors.slate400} multiline />
        </>
      )}

      <Text style={[styles.label, { marginTop: 18 }]}>Notes (optional)</Text>
      <TextInput style={[styles.input, styles.multiline]} value={notes} onChangeText={setNotes} placeholder="Notes shown on the invoice" placeholderTextColor={colors.slate400} multiline />

      <TouchableOpacity style={[styles.saveBtn, saving && styles.saveBtnDisabled]} onPress={save} disabled={saving}>
        <Text style={styles.saveText}>{saving ? "Saving…" : "Create draft invoice"}</Text>
      </TouchableOpacity>
      <Text style={styles.footnote}>Created as a draft. Sending / PDF / Xero are managed on the web dashboard.</Text>

      <CustomerPicker visible={pickCustomer} onClose={() => setPickCustomer(false)} onSelect={(c) => { setCustomer(c); setPickCustomer(false); }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 40 },
  prefill: { fontSize: 12, color: colors.blue600, fontWeight: "600", marginBottom: 6 },
  label: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginBottom: 6, marginTop: 10 },
  selector: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12, backgroundColor: colors.card },
  selectorText: { fontSize: 14, color: colors.slate900, fontWeight: "500" },
  placeholder: { color: colors.slate400, fontWeight: "400" },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, backgroundColor: colors.card, color: colors.slate900 },
  multiline: { minHeight: 64, textAlignVertical: "top" },
  varBlock: { marginTop: 14 },
  varHead: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginBottom: 8 },
  varChips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  varChip: { flexDirection: "row", alignItems: "center", gap: 4, maxWidth: "100%", paddingHorizontal: 10, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: colors.blue100, backgroundColor: colors.blue100 },
  varChipText: { fontSize: 12, fontWeight: "600", color: colors.blue600, flexShrink: 1 },
  saveBtn: { backgroundColor: colors.blue600, borderRadius: 10, paddingVertical: 14, alignItems: "center", marginTop: 22 },
  saveBtnDisabled: { opacity: 0.6 },
  saveText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  footnote: { fontSize: 11, color: colors.slate400, textAlign: "center", marginTop: 10 },
});
