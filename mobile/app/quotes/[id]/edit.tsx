import { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, TextInput, TouchableOpacity, Alert, Platform, ActivityIndicator } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import DateTimePicker, { type DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../../lib/theme";
import { formatQuoteNumber } from "../../../lib/finance";
import { useFinance } from "../../../lib/data/hooks/useFinance";
import { LineItemsEditor, type EditableItem } from "../../../components/finance/line-items-editor";
import { getQuote, type QuoteDetail } from "../../../lib/data/reads/finance";

export default function EditQuoteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const finance = useFinance();
  const [quote, setQuote] = useState<QuoteDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState("");
  const [validUntil, setValidUntil] = useState<Date | null>(null);
  const [showDate, setShowDate] = useState(false);
  const [items, setItems] = useState<EditableItem[]>([]);
  const [notes, setNotes] = useState("");
  const [existingItemIds, setExistingItemIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const q = await getQuote(id);
    setQuote(q);
    if (q) {
      setTitle(q.title);
      setValidUntil(q.valid_until ? new Date(q.valid_until) : null);
      setNotes(q.notes ?? "");
      setExistingItemIds(q.quote_items.map((i) => i.id));
      setItems(q.quote_items.map((i) => ({ key: `x-${i.id}`, name: i.name, description: i.description ?? "", quantity: String(i.quantity), unit_price: String(i.unit_price) })));
    }
    setLoading(false);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  function onDateChange(event: DateTimePickerEvent, selected?: Date) {
    setShowDate(Platform.OS === "ios");
    if (event.type === "set" && selected) setValidUntil(selected);
  }

  async function save() {
    if (saving || !finance.ready) return;
    const lineItems = items.filter((i) => i.name.trim()).map((i) => ({ name: i.name.trim(), description: i.description.trim() || null, quantity: parseFloat(i.quantity) || 0, unitPrice: parseFloat(i.unit_price) || 0 }));
    if (!title.trim()) { Alert.alert("Title required", "Enter a quote title."); return; }
    if (lineItems.length === 0) { Alert.alert("Line items required", "Add at least one named line item."); return; }
    setSaving(true);
    try {
      await finance.editQuote({ quoteId: id, title: title.trim(), validUntilIso: validUntil ? validUntil.toISOString().slice(0, 10) : null, notes: notes.trim() || null, existingItemIds, items: lineItems });
      router.replace(`/quotes/${id}`);
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <View style={styles.center}><Stack.Screen options={{ title: "Edit Quote" }} /><ActivityIndicator size="large" color={colors.blue600} /></View>;
  }
  if (!quote) {
    return <View style={styles.center}><Stack.Screen options={{ title: "Edit Quote" }} /><Text style={styles.muted}>Quote not found.</Text></View>;
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: `Edit ${formatQuoteNumber(quote.quote_number)}` }} />

      <Text style={styles.label}>Customer</Text>
      <View style={styles.readonly}><Text style={styles.readonlyText}>{quote.customers?.name ?? "—"}</Text></View>

      <Text style={styles.label}>Title</Text>
      <TextInput style={styles.input} value={title} onChangeText={setTitle} placeholderTextColor={colors.slate400} />

      <Text style={styles.label}>Valid until (optional)</Text>
      <TouchableOpacity style={styles.selector} onPress={() => setShowDate(true)}>
        <Text style={[styles.selectorText, !validUntil && styles.placeholder]}>{validUntil ? validUntil.toLocaleDateString("en-AU") : "No expiry"}</Text>
        <Ionicons name="calendar-outline" size={16} color={colors.slate400} />
      </TouchableOpacity>
      {showDate && <DateTimePicker value={validUntil ?? new Date()} mode="date" onChange={onDateChange} />}

      <Text style={[styles.label, { marginTop: 18 }]}>Line items</Text>
      <LineItemsEditor items={items} onChange={setItems} />

      <Text style={[styles.label, { marginTop: 18 }]}>Notes (optional)</Text>
      <TextInput style={[styles.input, styles.multiline]} value={notes} onChangeText={setNotes} placeholderTextColor={colors.slate400} multiline />

      <TouchableOpacity style={[styles.saveBtn, saving && styles.saveBtnDisabled]} onPress={save} disabled={saving}>
        <Text style={styles.saveText}>{saving ? "Saving…" : "Save changes"}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 40 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  muted: { fontSize: 13, color: colors.slate500 },
  label: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginBottom: 6, marginTop: 10 },
  readonly: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12, backgroundColor: colors.slate100 },
  readonlyText: { fontSize: 14, color: colors.slate700, fontWeight: "500" },
  selector: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12, backgroundColor: colors.card },
  selectorText: { fontSize: 14, color: colors.slate900, fontWeight: "500" },
  placeholder: { color: colors.slate400, fontWeight: "400" },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, backgroundColor: colors.card, color: colors.slate900 },
  multiline: { minHeight: 64, textAlignVertical: "top" },
  saveBtn: { backgroundColor: colors.blue600, borderRadius: 10, paddingVertical: 14, alignItems: "center", marginTop: 22 },
  saveBtnDisabled: { opacity: 0.6 },
  saveText: { color: "#fff", fontWeight: "700", fontSize: 15 },
});
