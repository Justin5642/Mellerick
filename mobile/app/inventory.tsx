import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, SectionList, StyleSheet, RefreshControl, TouchableOpacity, Modal, TextInput, Alert, ScrollView } from "react-native";
import { Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../lib/theme";
import { MoneyText } from "../design/components/MoneyText";
import { listInventory, type InventoryItem } from "../lib/data/reads/inventory";
import { lowStockItems } from "../lib/inventoryStock";
import { useInventory } from "../lib/data/hooks/useInventory";

interface Draft {
  id: string | null;
  name: string;
  sku: string;
  category: string;
  unit: string;
  quantity_on_hand: string;
  reorder_level: string;
  unit_cost: string;
  unit_sell: string;
  supplier: string;
  description: string;
}

function toDraft(it: InventoryItem | null): Draft {
  return {
    id: it?.id ?? null,
    name: it?.name ?? "",
    sku: it?.sku ?? "",
    category: it?.category ?? "",
    unit: it?.unit ?? "each",
    quantity_on_hand: it ? String(it.quantity_on_hand) : "0",
    reorder_level: it ? String(it.reorder_level) : "0",
    unit_cost: it ? String(it.unit_cost) : "0",
    unit_sell: it ? String(it.unit_sell) : "0",
    supplier: it?.supplier ?? "",
    description: it?.description ?? "",
  };
}

export default function InventoryScreen() {
  const inv = useInventory();
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => setItems(await listInventory()), []);
  useEffect(() => { load(); }, [load]);
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  const sections = useMemo(() => {
    const map = new Map<string, InventoryItem[]>();
    for (const it of items) {
      const cat = it.category ?? "Uncategorised";
      const arr = map.get(cat);
      if (arr) arr.push(it);
      else map.set(cat, [it]);
    }
    return Array.from(map, ([title, data]) => ({ title, data }));
  }, [items]);

  async function save() {
    if (!draft || saving || !inv.ready) return;
    const num = (s: string) => (s.trim() === "" ? 0 : parseFloat(s));
    if (!draft.name.trim() || [draft.quantity_on_hand, draft.reorder_level, draft.unit_cost, draft.unit_sell].some((s) => Number.isNaN(num(s)))) {
      Alert.alert("Missing details", "Name and numeric quantity/price fields are required.");
      return;
    }
    setSaving(true);
    try {
      const input = {
        name: draft.name.trim(),
        sku: draft.sku.trim() || null,
        description: draft.description.trim() || null,
        category: draft.category.trim() || null,
        unit: draft.unit.trim() || "each",
        quantityOnHand: num(draft.quantity_on_hand),
        reorderLevel: num(draft.reorder_level),
        unitCost: num(draft.unit_cost),
        unitSell: num(draft.unit_sell),
        supplier: draft.supplier.trim() || null,
      };
      const editingId = draft.id;
      const { result, synced } = editingId ? await inv.updateItem(editingId, input) : await inv.createItem(input);
      const rowId = editingId ?? (result as string);
      const optimistic: InventoryItem = {
        id: rowId,
        name: input.name, sku: input.sku, description: input.description, category: input.category, unit: input.unit,
        quantity_on_hand: input.quantityOnHand, reorder_level: input.reorderLevel, unit_cost: input.unitCost, unit_sell: input.unitSell, supplier: input.supplier,
      };
      setItems((prev) => (editingId ? prev.map((it) => (it.id === editingId ? optimistic : it)) : [...prev, optimistic]));
      setDraft(null);
      if (synced) await load();
    } finally {
      setSaving(false);
    }
  }

  async function deactivate() {
    if (!draft?.id || saving) return;
    setSaving(true);
    try {
      const id = draft.id;
      const { synced } = await inv.deactivateItem(id);
      setItems((prev) => prev.filter((it) => it.id !== id));
      setDraft(null);
      if (synced) await load();
    } finally {
      setSaving(false);
    }
  }

  const set = (k: keyof Draft) => (v: string) => setDraft((d) => d && { ...d, [k]: v });

  const lowStock = useMemo(() => lowStockItems(items), [items]);
  const LowStockBanner = lowStock.length === 0 ? null : (
    <View style={styles.lowBanner}>
      <Ionicons name="alert-circle" size={16} color={colors.orange700} />
      <Text style={styles.lowBannerText}>
        {lowStock.length} item{lowStock.length > 1 ? "s" : ""} at or below reorder level: {lowStock.map((i) => i.name).join(", ")}
      </Text>
    </View>
  );

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: "Inventory", headerRight: () => (
        <TouchableOpacity onPress={() => setDraft(toDraft(null))} accessibilityLabel="Add inventory item"><Ionicons name="add" size={26} color={colors.blue600} /></TouchableOpacity>
      ) }} />
      <SectionList
        sections={sections}
        keyExtractor={(i) => i.id}
        ListHeaderComponent={LowStockBanner}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.blue600} />}
        stickySectionHeadersEnabled={false}
        ListEmptyComponent={<Text style={styles.empty}>No inventory. Tap + to add.</Text>}
        renderSectionHeader={({ section }) => <Text style={styles.catHead}>{section.title}</Text>}
        renderItem={({ item }) => {
          const low = Number(item.quantity_on_hand) <= Number(item.reorder_level);
          return (
            <TouchableOpacity style={styles.row} onPress={() => setDraft(toDraft(item))}>
              <View style={styles.body}>
                <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
                <Text style={styles.meta} numberOfLines={1}>{[item.sku, item.supplier].filter(Boolean).join(" · ") || "—"}</Text>
              </View>
              <View style={styles.qtyCol}>
                <View style={[styles.qtyBadge, low && styles.qtyLow]}>
                  <Text style={[styles.qtyText, low && styles.qtyLowText]}>{item.quantity_on_hand} {item.unit ?? ""}</Text>
                </View>
                <MoneyText amount={item.unit_sell} style={styles.sell} />
                {Number(item.unit_sell) > 0 && (
                  <Text style={styles.margin}>{Math.round(((Number(item.unit_sell) - Number(item.unit_cost)) / Number(item.unit_sell)) * 100)}% margin</Text>
                )}
              </View>
            </TouchableOpacity>
          );
        }}
      />

      <Modal visible={!!draft} transparent animationType="slide" onRequestClose={() => !saving && setDraft(null)}>
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>{draft?.id ? "Edit item" : "New inventory item"}</Text>
            <ScrollView keyboardShouldPersistTaps="handled">
              <Field label="Name" value={draft?.name ?? ""} onChange={set("name")} />
              <View style={styles.twoCol}>
                <View style={{ flex: 1 }}><Field label="SKU" value={draft?.sku ?? ""} onChange={set("sku")} /></View>
                <View style={{ flex: 1 }}><Field label="Category" value={draft?.category ?? ""} onChange={set("category")} /></View>
              </View>
              <View style={styles.twoCol}>
                <View style={{ flex: 1 }}><Field label="Qty on hand" value={draft?.quantity_on_hand ?? ""} onChange={set("quantity_on_hand")} keyboardType="decimal-pad" /></View>
                <View style={{ flex: 1 }}><Field label="Reorder level" value={draft?.reorder_level ?? ""} onChange={set("reorder_level")} keyboardType="decimal-pad" /></View>
              </View>
              <View style={styles.twoCol}>
                <View style={{ flex: 1 }}><Field label="Unit cost" value={draft?.unit_cost ?? ""} onChange={set("unit_cost")} keyboardType="decimal-pad" /></View>
                <View style={{ flex: 1 }}><Field label="Unit sell" value={draft?.unit_sell ?? ""} onChange={set("unit_sell")} keyboardType="decimal-pad" /></View>
              </View>
              <View style={styles.twoCol}>
                <View style={{ flex: 1 }}><Field label="Unit" value={draft?.unit ?? ""} onChange={set("unit")} /></View>
                <View style={{ flex: 1 }}><Field label="Supplier" value={draft?.supplier ?? ""} onChange={set("supplier")} /></View>
              </View>
              <Field label="Description" value={draft?.description ?? ""} onChange={set("description")} multiline />
            </ScrollView>
            <View style={styles.actions}>
              {draft?.id ? <TouchableOpacity style={styles.deactivate} onPress={deactivate} disabled={saving}><Text style={styles.deactivateText}>Deactivate</Text></TouchableOpacity> : null}
              <TouchableOpacity style={styles.cancel} onPress={() => setDraft(null)} disabled={saving}><Text style={styles.cancelText}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity style={styles.saveBtn} onPress={save} disabled={saving}><Text style={styles.saveText}>{saving ? "…" : "Save"}</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function Field({ label, value, onChange, keyboardType, multiline }: { label: string; value: string; onChange: (v: string) => void; keyboardType?: "default" | "decimal-pad"; multiline?: boolean }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput style={[styles.input, multiline && styles.multiline]} value={value} onChangeText={onChange} keyboardType={keyboardType ?? "default"} multiline={multiline} placeholderTextColor={colors.slate400} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  lowBanner: { flexDirection: "row", alignItems: "flex-start", gap: 8, backgroundColor: colors.orange100, marginHorizontal: 12, marginTop: 12, borderRadius: 10, padding: 10 },
  lowBannerText: { flex: 1, fontSize: 12, color: colors.orange700, lineHeight: 16 },
  catHead: { fontSize: 13, fontWeight: "700", color: colors.slate500, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4, textTransform: "capitalize" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: colors.card, borderTopWidth: 1, borderTopColor: colors.border },
  body: { flex: 1, minWidth: 0 },
  name: { fontSize: 14, fontWeight: "600", color: colors.slate900 },
  meta: { fontSize: 12, color: colors.slate500, marginTop: 2 },
  qtyCol: { alignItems: "flex-end", gap: 3 },
  qtyBadge: { backgroundColor: colors.slate100, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  qtyLow: { backgroundColor: colors.red100 },
  qtyText: { fontSize: 12, fontWeight: "600", color: colors.slate700 },
  qtyLowText: { color: colors.red600 },
  sell: { fontSize: 13, fontWeight: "700", color: colors.slate900 },
  margin: { fontSize: 11, color: colors.slate400 },
  empty: { textAlign: "center", color: colors.slate400, marginTop: 40, fontSize: 13 },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, paddingBottom: 28, maxHeight: "88%" },
  sheetTitle: { fontSize: 16, fontWeight: "800", color: colors.slate900, marginBottom: 12 },
  field: { marginBottom: 12 },
  fieldLabel: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginBottom: 6 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, backgroundColor: colors.bg, color: colors.slate900 },
  multiline: { minHeight: 60, textAlignVertical: "top" },
  twoCol: { flexDirection: "row", gap: 12 },
  actions: { flexDirection: "row", gap: 10, marginTop: 12, alignItems: "center" },
  deactivate: { paddingHorizontal: 14, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.red100, borderWidth: 1, borderColor: colors.red600 },
  deactivateText: { color: colors.red600, fontWeight: "600", fontSize: 13 },
  cancel: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.bg, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  cancelText: { color: colors.slate700, fontWeight: "600", fontSize: 14 },
  saveBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.blue600, alignItems: "center" },
  saveText: { color: "#fff", fontWeight: "700", fontSize: 14 },
});
