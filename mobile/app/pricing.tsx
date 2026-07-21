import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, SectionList, StyleSheet, RefreshControl, TouchableOpacity, Modal, TextInput, Alert, ScrollView } from "react-native";
import { Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../lib/theme";
import { MoneyText } from "../design/components/MoneyText";
import { listPricing, type PricingItem } from "../lib/data/reads/finance";
import { useFinance } from "../lib/data/hooks/useFinance";

const PRICING_TYPES = ["flat_rate", "hourly", "material"] as const;

function humanize(v: string): string {
  return v.replace(/_/g, " ");
}

interface Draft {
  id: string | null; // null = new
  name: string;
  category: string;
  pricing_type: (typeof PRICING_TYPES)[number];
  unit_price: string;
  unit: string;
  description: string;
}

function toDraft(item: PricingItem | null): Draft {
  return {
    id: item?.id ?? null,
    name: item?.name ?? "",
    category: item?.category ?? "",
    pricing_type: (item?.pricing_type as Draft["pricing_type"]) ?? "flat_rate",
    unit_price: item ? String(item.unit_price) : "",
    unit: item?.unit ?? "each",
    description: item?.description ?? "",
  };
}

export default function PricingScreen() {
  const finance = useFinance();
  const [items, setItems] = useState<PricingItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setItems(await listPricing());
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const sections = useMemo(() => {
    const map = new Map<string, PricingItem[]>();
    for (const it of items) {
      const arr = map.get(it.category);
      if (arr) arr.push(it);
      else map.set(it.category, [it]);
    }
    return Array.from(map, ([title, data]) => ({ title, data }));
  }, [items]);

  async function save() {
    if (!draft || saving || !finance.ready) return;
    const price = parseFloat(draft.unit_price);
    if (!draft.name.trim() || !draft.category.trim() || Number.isNaN(price)) {
      Alert.alert("Missing details", "Name, category and a numeric price are required.");
      return;
    }
    setSaving(true);
    try {
      const input = {
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        category: draft.category.trim(),
        pricingType: draft.pricing_type,
        unitPrice: price,
        unit: draft.unit.trim() || "each",
      };
      const { synced } = draft.id ? await finance.updatePricingItem(draft.id, input) : await finance.createPricingItem(input);
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
      const { synced } = await finance.deactivatePricingItem(draft.id);
      setDraft(null);
      if (synced) await load();
    } finally {
      setSaving(false);
    }
  }

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: "Pricing",
          headerRight: () => (
            <TouchableOpacity onPress={() => setDraft(toDraft(null))} accessibilityLabel="Add pricing item">
              <Ionicons name="add" size={26} color={colors.blue600} />
            </TouchableOpacity>
          ),
        }}
      />
      <SectionList
        sections={sections}
        keyExtractor={(i) => i.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.blue600} />}
        stickySectionHeadersEnabled={false}
        ListEmptyComponent={<Text style={styles.empty}>No pricing items. Tap + to add one.</Text>}
        renderSectionHeader={({ section }) => <Text style={styles.catHead}>{humanize(section.title)}</Text>}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.row} onPress={() => setDraft(toDraft(item))}>
            <View style={styles.body}>
              <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
              <Text style={styles.meta} numberOfLines={1}>
                {humanize(item.pricing_type)}
                {item.description ? ` · ${item.description}` : ""}
              </Text>
            </View>
            <View style={styles.priceCol}>
              <MoneyText amount={item.unit_price} style={styles.price} />
              <Text style={styles.unit}>/ {item.unit ?? "each"}</Text>
            </View>
          </TouchableOpacity>
        )}
      />

      <Modal visible={!!draft} transparent animationType="slide" onRequestClose={() => !saving && setDraft(null)}>
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>{draft?.id ? "Edit item" : "New pricing item"}</Text>
            <ScrollView keyboardShouldPersistTaps="handled">
              <Field label="Name" value={draft?.name ?? ""} onChange={(v) => setDraft((d) => d && { ...d, name: v })} />
              <Field label="Category" value={draft?.category ?? ""} onChange={(v) => setDraft((d) => d && { ...d, category: v })} />
              <Text style={styles.fieldLabel}>Type</Text>
              <View style={styles.segment}>
                {PRICING_TYPES.map((t) => (
                  <TouchableOpacity
                    key={t}
                    style={[styles.segItem, draft?.pricing_type === t && styles.segItemActive]}
                    onPress={() => setDraft((d) => d && { ...d, pricing_type: t })}
                  >
                    <Text style={[styles.segText, draft?.pricing_type === t && styles.segTextActive]}>{humanize(t)}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={styles.twoCol}>
                <View style={{ flex: 1 }}>
                  <Field label="Unit price" value={draft?.unit_price ?? ""} onChange={(v) => setDraft((d) => d && { ...d, unit_price: v })} keyboardType="decimal-pad" />
                </View>
                <View style={{ flex: 1 }}>
                  <Field label="Unit" value={draft?.unit ?? ""} onChange={(v) => setDraft((d) => d && { ...d, unit: v })} />
                </View>
              </View>
              <Field label="Description (optional)" value={draft?.description ?? ""} onChange={(v) => setDraft((d) => d && { ...d, description: v })} />
            </ScrollView>
            <View style={styles.actions}>
              {draft?.id ? (
                <TouchableOpacity style={styles.deactivate} onPress={deactivate} disabled={saving}>
                  <Text style={styles.deactivateText}>Deactivate</Text>
                </TouchableOpacity>
              ) : null}
              <TouchableOpacity style={styles.cancel} onPress={() => setDraft(null)} disabled={saving}>
                <Text style={styles.cancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.saveBtn} onPress={save} disabled={saving}>
                <Text style={styles.saveText}>{saving ? "…" : "Save"}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function Field({ label, value, onChange, keyboardType }: { label: string; value: string; onChange: (v: string) => void; keyboardType?: "default" | "decimal-pad" }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput style={styles.input} value={value} onChangeText={onChange} keyboardType={keyboardType ?? "default"} placeholderTextColor={colors.slate400} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  catHead: { fontSize: 13, fontWeight: "700", color: colors.slate500, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4, textTransform: "capitalize" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: colors.card, borderTopWidth: 1, borderTopColor: colors.border },
  body: { flex: 1, minWidth: 0 },
  name: { fontSize: 14, fontWeight: "600", color: colors.slate900 },
  meta: { fontSize: 12, color: colors.slate500, marginTop: 2, textTransform: "capitalize" },
  priceCol: { alignItems: "flex-end" },
  price: { fontSize: 14, fontWeight: "700", color: colors.slate900 },
  unit: { fontSize: 11, color: colors.slate400 },
  empty: { textAlign: "center", color: colors.slate400, marginTop: 40, fontSize: 13 },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, paddingBottom: 28, maxHeight: "85%" },
  sheetTitle: { fontSize: 16, fontWeight: "800", color: colors.slate900, marginBottom: 12 },
  field: { marginBottom: 12 },
  fieldLabel: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginBottom: 6 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, backgroundColor: colors.bg, color: colors.slate900 },
  segment: { flexDirection: "row", gap: 8, marginBottom: 12 },
  segItem: { flex: 1, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: colors.border, alignItems: "center", backgroundColor: colors.bg },
  segItemActive: { backgroundColor: colors.blue600, borderColor: colors.blue600 },
  segText: { fontSize: 12, fontWeight: "600", color: colors.slate700, textTransform: "capitalize" },
  segTextActive: { color: "#fff" },
  twoCol: { flexDirection: "row", gap: 12 },
  actions: { flexDirection: "row", gap: 10, marginTop: 12, alignItems: "center" },
  deactivate: { paddingHorizontal: 14, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.red100, borderWidth: 1, borderColor: colors.red600 },
  deactivateText: { color: colors.red600, fontWeight: "600", fontSize: 13 },
  cancel: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.bg, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  cancelText: { color: colors.slate700, fontWeight: "600", fontSize: 14 },
  saveBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.blue600, alignItems: "center" },
  saveText: { color: "#fff", fontWeight: "700", fontSize: 14 },
});
