import { useEffect, useState } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Modal, FlatList } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { MoneyText } from "../../design/components/MoneyText";
import { computeTotals } from "../../lib/data/repositories/finance";
import { listPricing, type PricingItem } from "../../lib/data/reads/finance";

// String-form line item for editing; converted to LineItemInput on save.
export interface EditableItem {
  key: string;
  name: string;
  description: string;
  quantity: string;
  unit_price: string;
  /** Set when this line was pulled from an unbilled job variation (create-from-
   * job flow) — so it can be marked billed on save. Not user-editable. */
  variationId?: string;
}

let counter = 0;
export function newItem(seed?: Partial<EditableItem>): EditableItem {
  return { key: `li-${++counter}`, name: "", description: "", quantity: "1", unit_price: "0", ...seed };
}

export function LineItemsEditor({ items, onChange }: { items: EditableItem[]; onChange: (items: EditableItem[]) => void }) {
  const [catalogueOpen, setCatalogueOpen] = useState(false);

  const totals = computeTotals(items.map((i) => ({ name: i.name, quantity: parseFloat(i.quantity) || 0, unitPrice: parseFloat(i.unit_price) || 0 })));

  const update = (key: string, patch: Partial<EditableItem>) => onChange(items.map((i) => (i.key === key ? { ...i, ...patch } : i)));
  const remove = (key: string) => onChange(items.filter((i) => i.key !== key));

  return (
    <View>
      {items.map((item) => (
        <View key={item.key} style={styles.item}>
          <View style={styles.itemTop}>
            <TextInput style={styles.nameInput} value={item.name} onChangeText={(v) => update(item.key, { name: v })} placeholder="Item name" placeholderTextColor={colors.slate400} />
            <TouchableOpacity onPress={() => remove(item.key)} accessibilityLabel="Remove line"><Ionicons name="close-circle" size={20} color={colors.slate400} /></TouchableOpacity>
          </View>
          <TextInput style={styles.descInput} value={item.description} onChangeText={(v) => update(item.key, { description: v })} placeholder="Description (optional)" placeholderTextColor={colors.slate400} />
          <View style={styles.itemBottom}>
            <View style={styles.qtyBox}>
              <Text style={styles.smallLabel}>Qty</Text>
              <TextInput style={styles.numInput} value={item.quantity} onChangeText={(v) => update(item.key, { quantity: v })} keyboardType="decimal-pad" />
            </View>
            <View style={styles.qtyBox}>
              <Text style={styles.smallLabel}>Unit price</Text>
              <TextInput style={styles.numInput} value={item.unit_price} onChangeText={(v) => update(item.key, { unit_price: v })} keyboardType="decimal-pad" />
            </View>
            <View style={styles.lineTotal}>
              <Text style={styles.smallLabel}>Line total</Text>
              <MoneyText amount={(parseFloat(item.quantity) || 0) * (parseFloat(item.unit_price) || 0)} style={styles.lineTotalText} />
            </View>
          </View>
        </View>
      ))}

      <View style={styles.addRow}>
        <TouchableOpacity style={styles.addBtn} onPress={() => onChange([...items, newItem()])}>
          <Ionicons name="add" size={16} color={colors.blue600} />
          <Text style={styles.addText}>Add line</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.addBtn} onPress={() => setCatalogueOpen(true)}>
          <Ionicons name="pricetags-outline" size={15} color={colors.blue600} />
          <Text style={styles.addText}>From catalogue</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.totals}>
        <TotalRow label="Subtotal (ex GST)" amount={totals.subtotal} />
        <TotalRow label="GST (10%)" amount={totals.gst} />
        <TotalRow label="Total" amount={totals.total} strong />
      </View>

      <CataloguePicker
        visible={catalogueOpen}
        onClose={() => setCatalogueOpen(false)}
        onSelect={(p) => {
          onChange([...items, newItem({ name: p.name, description: p.description ?? "", unit_price: String(p.unit_price) })]);
          setCatalogueOpen(false);
        }}
      />
    </View>
  );
}

function TotalRow({ label, amount, strong }: { label: string; amount: number; strong?: boolean }) {
  return (
    <View style={styles.totalRow}>
      <Text style={[styles.totalLabel, strong && styles.bold]}>{label}</Text>
      <MoneyText amount={amount} style={[styles.totalValue, strong && styles.totalStrong]} />
    </View>
  );
}

function CataloguePicker({ visible, onClose, onSelect }: { visible: boolean; onClose: () => void; onSelect: (p: PricingItem) => void }) {
  const [rows, setRows] = useState<PricingItem[]>([]);
  useEffect(() => {
    if (visible) listPricing().then(setRows);
  }, [visible]);
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.head}>
            <Text style={styles.sheetTitle}>Add from catalogue</Text>
            <TouchableOpacity onPress={onClose}><Ionicons name="close" size={22} color={colors.slate500} /></TouchableOpacity>
          </View>
          <FlatList
            data={rows}
            keyExtractor={(p) => p.id}
            ListEmptyComponent={<Text style={styles.empty}>No pricing items.</Text>}
            renderItem={({ item }) => (
              <TouchableOpacity style={styles.catRow} onPress={() => onSelect(item)}>
                <Text style={styles.catName}>{item.name}</Text>
                <MoneyText amount={item.unit_price} style={styles.catPrice} />
              </TouchableOpacity>
            )}
          />
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  item: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 10, marginBottom: 8, gap: 6 },
  itemTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  nameInput: { flex: 1, fontSize: 14, fontWeight: "600", color: colors.slate900, padding: 0 },
  descInput: { fontSize: 12, color: colors.slate500, padding: 0 },
  itemBottom: { flexDirection: "row", gap: 10, alignItems: "flex-end" },
  qtyBox: { width: 80 },
  smallLabel: { fontSize: 10, color: colors.slate400, textTransform: "uppercase", fontWeight: "700", marginBottom: 2 },
  numInput: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, fontSize: 13, backgroundColor: colors.card, color: colors.slate900 },
  lineTotal: { flex: 1, alignItems: "flex-end" },
  lineTotalText: { fontSize: 14, fontWeight: "700", color: colors.slate900 },
  addRow: { flexDirection: "row", gap: 10, marginTop: 2, marginBottom: 12 },
  addBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
  addText: { fontSize: 13, color: colors.blue600, fontWeight: "600" },
  totals: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10, gap: 3 },
  totalRow: { flexDirection: "row", justifyContent: "space-between" },
  totalLabel: { fontSize: 13, color: colors.slate500 },
  totalValue: { fontSize: 13, color: colors.slate900, fontWeight: "500" },
  bold: { fontWeight: "700" },
  totalStrong: { fontSize: 17, fontWeight: "800", color: colors.slate900 },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, paddingBottom: 24, height: "70%" },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  sheetTitle: { fontSize: 16, fontWeight: "800", color: colors.slate900 },
  catRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.border },
  catName: { fontSize: 14, color: colors.slate900, flex: 1 },
  catPrice: { fontSize: 14, fontWeight: "700", color: colors.slate900 },
  empty: { textAlign: "center", color: colors.slate400, marginTop: 30, fontSize: 13 },
});
