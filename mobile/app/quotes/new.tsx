import { useState } from "react";
import { View, Text, ScrollView, StyleSheet, TextInput, TouchableOpacity, Alert, Platform } from "react-native";
import { Stack, useRouter } from "expo-router";
import DateTimePicker, { type DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { useFinance } from "../../lib/data/hooks/useFinance";
import { CustomerPicker } from "../../components/finance/customer-picker";
import { LineItemsEditor, newItem, type EditableItem } from "../../components/finance/line-items-editor";
import type { CustomerListRow } from "../../lib/data/reads/customers";

export default function NewQuoteScreen() {
  const router = useRouter();
  const finance = useFinance();
  const [customer, setCustomer] = useState<CustomerListRow | null>(null);
  const [pickCustomer, setPickCustomer] = useState(false);
  const [title, setTitle] = useState("");
  const [validUntil, setValidUntil] = useState<Date | null>(null);
  const [showDate, setShowDate] = useState(false);
  const [items, setItems] = useState<EditableItem[]>([newItem()]);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  function onDateChange(event: DateTimePickerEvent, selected?: Date) {
    setShowDate(Platform.OS === "ios");
    if (event.type === "set" && selected) setValidUntil(selected);
  }

  async function save() {
    if (saving || !finance.ready) return;
    const lineItems = items
      .filter((i) => i.name.trim())
      .map((i) => ({ name: i.name.trim(), description: i.description.trim() || null, quantity: parseFloat(i.quantity) || 0, unitPrice: parseFloat(i.unit_price) || 0 }));
    if (!customer) { Alert.alert("Customer required", "Select a customer for this quote."); return; }
    if (!title.trim()) { Alert.alert("Title required", "Enter a quote title."); return; }
    if (lineItems.length === 0) { Alert.alert("Line items required", "Add at least one named line item."); return; }
    setSaving(true);
    try {
      const { result, synced } = await finance.createQuote({
        customerId: customer.id,
        title: title.trim(),
        validUntilIso: validUntil ? validUntil.toISOString().slice(0, 10) : null,
        notes: notes.trim() || null,
        items: lineItems,
      });
      if (synced) {
        router.replace(`/quotes/${result}`);
      } else {
        Alert.alert("Saved offline", "The draft quote is queued and will sync when you're back online.");
        router.back();
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: "New Quote" }} />

      <Text style={styles.label}>Customer</Text>
      <TouchableOpacity style={styles.selector} onPress={() => setPickCustomer(true)}>
        <Text style={[styles.selectorText, !customer && styles.placeholder]}>{customer ? customer.name : "Select customer…"}</Text>
        <Ionicons name="chevron-forward" size={16} color={colors.slate400} />
      </TouchableOpacity>

      <Text style={styles.label}>Title</Text>
      <TextInput style={styles.input} value={title} onChangeText={setTitle} placeholder="e.g. Backflow installation" placeholderTextColor={colors.slate400} />

      <Text style={styles.label}>Valid until (optional)</Text>
      <TouchableOpacity style={styles.selector} onPress={() => setShowDate(true)}>
        <Text style={[styles.selectorText, !validUntil && styles.placeholder]}>{validUntil ? validUntil.toLocaleDateString("en-AU") : "No expiry"}</Text>
        <Ionicons name="calendar-outline" size={16} color={colors.slate400} />
      </TouchableOpacity>
      {showDate && <DateTimePicker value={validUntil ?? new Date()} mode="date" onChange={onDateChange} />}

      <Text style={[styles.label, { marginTop: 18 }]}>Line items</Text>
      <LineItemsEditor items={items} onChange={setItems} />

      <Text style={[styles.label, { marginTop: 18 }]}>Notes (optional)</Text>
      <TextInput style={[styles.input, styles.multiline]} value={notes} onChangeText={setNotes} placeholder="Notes shown on the quote" placeholderTextColor={colors.slate400} multiline />

      <TouchableOpacity style={[styles.saveBtn, saving && styles.saveBtnDisabled]} onPress={save} disabled={saving}>
        <Text style={styles.saveText}>{saving ? "Saving…" : "Create draft quote"}</Text>
      </TouchableOpacity>
      <Text style={styles.footnote}>Created as a draft. Sending / PDF are managed on the web dashboard.</Text>

      <CustomerPicker visible={pickCustomer} onClose={() => setPickCustomer(false)} onSelect={(c) => { setCustomer(c); setPickCustomer(false); }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 40 },
  label: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginBottom: 6, marginTop: 10 },
  selector: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12, backgroundColor: colors.card },
  selectorText: { fontSize: 14, color: colors.slate900, fontWeight: "500" },
  placeholder: { color: colors.slate400, fontWeight: "400" },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, backgroundColor: colors.card, color: colors.slate900 },
  multiline: { minHeight: 64, textAlignVertical: "top" },
  saveBtn: { backgroundColor: colors.blue600, borderRadius: 10, paddingVertical: 14, alignItems: "center", marginTop: 22 },
  saveBtnDisabled: { opacity: 0.6 },
  saveText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  footnote: { fontSize: 11, color: colors.slate400, textAlign: "center", marginTop: 10 },
});
