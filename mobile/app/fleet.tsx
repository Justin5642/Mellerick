import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, SectionList, StyleSheet, RefreshControl, TouchableOpacity, Modal, TextInput, Alert, ScrollView } from "react-native";
import { Stack, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../lib/theme";
import { MoneyText } from "../design/components/MoneyText";
import { listEquipment, hourlyRate, type Equipment } from "../lib/data/reads/fleet";
import { listAssignableStaff, type AssignableStaff } from "../lib/data/reads/schedule";
import { useFleet } from "../lib/data/hooks/useFleet";
import { useIsAdmin } from "../design/guards/useRole";

const CATEGORIES = ["vehicle", "machinery", "tool", "other"] as const;

interface Draft {
  id: string | null;
  name: string;
  category: (typeof CATEGORIES)[number];
  registration: string;
  purchase_cost: string;
  estimated_life_years: string;
  insurance_annual: string;
  maintenance_annual: string;
  registration_annual: string;
  other_annual_costs: string;
  fuel_cost_per_hour: string;
  target_hours_per_year: string;
  notes: string;
}

function toDraft(e: Equipment | null): Draft {
  return {
    id: e?.id ?? null,
    name: e?.name ?? "",
    category: (e?.category as Draft["category"]) ?? "vehicle",
    registration: e?.registration ?? "",
    purchase_cost: e ? String(e.purchase_cost) : "0",
    estimated_life_years: e ? String(e.estimated_life_years) : "5",
    insurance_annual: e ? String(e.insurance_annual) : "0",
    maintenance_annual: e ? String(e.maintenance_annual) : "0",
    registration_annual: e ? String(e.registration_annual) : "0",
    other_annual_costs: e ? String(e.other_annual_costs) : "0",
    fuel_cost_per_hour: e ? String(e.fuel_cost_per_hour) : "0",
    target_hours_per_year: e ? String(e.target_hours_per_year) : "1000",
    notes: e?.notes ?? "",
  };
}

export default function FleetScreen() {
  const fleet = useFleet();
  const router = useRouter();
  const isAdmin = useIsAdmin(); // equipment writes are admin-only (RLS + web)
  const [items, setItems] = useState<Equipment[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [assignFor, setAssignFor] = useState<Equipment | null>(null);
  const [staff, setStaff] = useState<AssignableStaff[]>([]);

  const load = useCallback(async () => setItems(await listEquipment()), []);
  useEffect(() => { load(); }, [load]);

  function openAssign(item: Equipment) {
    if (staff.length === 0) listAssignableStaff().then(setStaff).catch(() => {});
    setAssignFor(item);
  }
  async function doAssign(staffId: string | null) {
    if (!assignFor || saving || !fleet.ready) return;
    setSaving(true);
    try {
      await fleet.assignEquipment(assignFor.id, staffId);
      setAssignFor(null);
      await load();
    } catch (e) {
      Alert.alert("Couldn't assign", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setSaving(false);
    }
  }
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  const sections = useMemo(() => {
    const map = new Map<string, Equipment[]>();
    for (const e of items) {
      const arr = map.get(e.category);
      if (arr) arr.push(e);
      else map.set(e.category, [e]);
    }
    return Array.from(map, ([title, data]) => ({ title, data }));
  }, [items]);

  async function save() {
    if (!draft || saving || !fleet.ready) return;
    const num = (s: string) => (s.trim() === "" ? 0 : parseFloat(s));
    const numericKeys: (keyof Draft)[] = ["purchase_cost", "estimated_life_years", "insurance_annual", "maintenance_annual", "registration_annual", "other_annual_costs", "fuel_cost_per_hour", "target_hours_per_year"];
    if (!draft.name.trim() || numericKeys.some((k) => Number.isNaN(num(draft[k] as string)))) {
      Alert.alert("Missing details", "Name and numeric cost fields are required.");
      return;
    }
    setSaving(true);
    try {
      const input = {
        name: draft.name.trim(),
        category: draft.category,
        registration: draft.registration.trim() || null,
        purchaseCost: num(draft.purchase_cost),
        estimatedLifeYears: num(draft.estimated_life_years),
        insuranceAnnual: num(draft.insurance_annual),
        maintenanceAnnual: num(draft.maintenance_annual),
        registrationAnnual: num(draft.registration_annual),
        otherAnnualCosts: num(draft.other_annual_costs),
        fuelCostPerHour: num(draft.fuel_cost_per_hour),
        targetHoursPerYear: num(draft.target_hours_per_year),
        notes: draft.notes.trim() || null,
      };
      const editingId = draft.id;
      const { result, synced } = editingId ? await fleet.updateEquipment(editingId, input) : await fleet.createEquipment(input);
      const rowId = editingId ?? (result as string);
      const optimistic: Equipment = {
        id: rowId, name: input.name, category: input.category, registration: input.registration,
        purchase_cost: input.purchaseCost, purchase_date: null, estimated_life_years: input.estimatedLifeYears,
        insurance_annual: input.insuranceAnnual, maintenance_annual: input.maintenanceAnnual, registration_annual: input.registrationAnnual,
        other_annual_costs: input.otherAnnualCosts, fuel_cost_per_hour: input.fuelCostPerHour, target_hours_per_year: input.targetHoursPerYear, notes: input.notes,
        assigned_to: null, assigned_profile: null,
      };
      // Editing cost fields must not wipe the current assignee optimistically.
      setItems((prev) => (editingId ? prev.map((it) => (it.id === editingId ? { ...optimistic, assigned_to: it.assigned_to, assigned_profile: it.assigned_profile } : it)) : [...prev, optimistic]));
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
      const { synced } = await fleet.deactivateEquipment(id);
      setItems((prev) => prev.filter((it) => it.id !== id));
      setDraft(null);
      if (synced) await load();
    } finally {
      setSaving(false);
    }
  }

  const set = (k: keyof Draft) => (v: string) => setDraft((d) => d && { ...d, [k]: v });

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: "Fleet & Equipment", headerRight: isAdmin ? () => (
        <TouchableOpacity onPress={() => setDraft(toDraft(null))} accessibilityLabel="Add equipment"><Ionicons name="add" size={26} color={colors.blue600} /></TouchableOpacity>
      ) : undefined }} />
      <SectionList
        sections={sections}
        keyExtractor={(i) => i.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.blue600} />}
        stickySectionHeadersEnabled={false}
        ListEmptyComponent={<Text style={styles.empty}>No equipment. Tap + to add.</Text>}
        renderSectionHeader={({ section }) => <Text style={styles.catHead}>{section.title}</Text>}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.row} onPress={() => isAdmin && setDraft(toDraft(item))} onLongPress={() => isAdmin && openAssign(item)} activeOpacity={isAdmin ? 0.6 : 1}>
            <View style={styles.body}>
              <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
              <Text style={styles.meta} numberOfLines={1}>
                {item.registration || item.category}
                {item.assigned_profile?.full_name ? ` · ${item.assigned_profile.full_name}` : ""}
              </Text>
            </View>
            <View style={styles.rateCol}>
              <MoneyText amount={hourlyRate(item)} style={styles.rate} />
              <Text style={styles.rateUnit}>/ hr (est.)</Text>
            </View>
            <TouchableOpacity onPress={() => router.push(`/fleet/${item.id}`)} style={styles.detailBtn} accessibilityLabel="Equipment details" hitSlop={8}>
              <Ionicons name="chevron-forward" size={18} color={colors.slate400} />
            </TouchableOpacity>
          </TouchableOpacity>
        )}
      />

      <Modal visible={!!draft} transparent animationType="slide" onRequestClose={() => !saving && setDraft(null)}>
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>{draft?.id ? "Edit equipment" : "New equipment"}</Text>
            <ScrollView keyboardShouldPersistTaps="handled">
              <Field label="Name" value={draft?.name ?? ""} onChange={set("name")} />
              <Text style={styles.fieldLabel}>Category</Text>
              <View style={styles.segment}>
                {CATEGORIES.map((c) => (
                  <TouchableOpacity key={c} style={[styles.segItem, draft?.category === c && styles.segItemActive]} onPress={() => setDraft((d) => d && { ...d, category: c })}>
                    <Text style={[styles.segText, draft?.category === c && styles.segTextActive]}>{c}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Field label="Registration" value={draft?.registration ?? ""} onChange={set("registration")} />
              <View style={styles.twoCol}>
                <View style={{ flex: 1 }}><Field label="Purchase cost" value={draft?.purchase_cost ?? ""} onChange={set("purchase_cost")} num /></View>
                <View style={{ flex: 1 }}><Field label="Life (years)" value={draft?.estimated_life_years ?? ""} onChange={set("estimated_life_years")} num /></View>
              </View>
              <View style={styles.twoCol}>
                <View style={{ flex: 1 }}><Field label="Insurance /yr" value={draft?.insurance_annual ?? ""} onChange={set("insurance_annual")} num /></View>
                <View style={{ flex: 1 }}><Field label="Maintenance /yr" value={draft?.maintenance_annual ?? ""} onChange={set("maintenance_annual")} num /></View>
              </View>
              <View style={styles.twoCol}>
                <View style={{ flex: 1 }}><Field label="Registration /yr" value={draft?.registration_annual ?? ""} onChange={set("registration_annual")} num /></View>
                <View style={{ flex: 1 }}><Field label="Other /yr" value={draft?.other_annual_costs ?? ""} onChange={set("other_annual_costs")} num /></View>
              </View>
              <View style={styles.twoCol}>
                <View style={{ flex: 1 }}><Field label="Fuel /hr" value={draft?.fuel_cost_per_hour ?? ""} onChange={set("fuel_cost_per_hour")} num /></View>
                <View style={{ flex: 1 }}><Field label="Target hrs/yr" value={draft?.target_hours_per_year ?? ""} onChange={set("target_hours_per_year")} num /></View>
              </View>
              <Field label="Notes" value={draft?.notes ?? ""} onChange={set("notes")} multiline />
            </ScrollView>
            <View style={styles.actions}>
              {draft?.id ? <TouchableOpacity style={styles.deactivate} onPress={deactivate} disabled={saving}><Text style={styles.deactivateText}>Deactivate</Text></TouchableOpacity> : null}
              <TouchableOpacity style={styles.cancel} onPress={() => setDraft(null)} disabled={saving}><Text style={styles.cancelText}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity style={styles.saveBtn} onPress={save} disabled={saving}><Text style={styles.saveText}>{saving ? "…" : "Save"}</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={!!assignFor} transparent animationType="slide" onRequestClose={() => !saving && setAssignFor(null)}>
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>Assign {assignFor?.name}</Text>
            <ScrollView style={{ maxHeight: 360 }}>
              <TouchableOpacity style={styles.assignRow} onPress={() => doAssign(null)} disabled={saving}>
                <Ionicons name="close-circle-outline" size={18} color={colors.slate500} />
                <Text style={styles.assignName}>Unassign</Text>
                {!assignFor?.assigned_to && <Ionicons name="checkmark" size={18} color={colors.blue600} />}
              </TouchableOpacity>
              {staff.map((s) => (
                <TouchableOpacity key={s.id} style={styles.assignRow} onPress={() => doAssign(s.id)} disabled={saving}>
                  <Ionicons name="person-circle-outline" size={18} color={colors.slate500} />
                  <Text style={styles.assignName}>{s.full_name}</Text>
                  {assignFor?.assigned_to === s.id && <Ionicons name="checkmark" size={18} color={colors.blue600} />}
                </TouchableOpacity>
              ))}
            </ScrollView>
            <TouchableOpacity style={styles.cancel} onPress={() => setAssignFor(null)} disabled={saving}><Text style={styles.cancelText}>Cancel</Text></TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function Field({ label, value, onChange, num, multiline }: { label: string; value: string; onChange: (v: string) => void; num?: boolean; multiline?: boolean }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput style={[styles.input, multiline && styles.multiline]} value={value} onChangeText={onChange} keyboardType={num ? "decimal-pad" : "default"} multiline={multiline} placeholderTextColor={colors.slate400} />
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
  rateCol: { alignItems: "flex-end" },
  detailBtn: { paddingLeft: 8, paddingVertical: 8 },
  rate: { fontSize: 14, fontWeight: "700", color: colors.slate900 },
  rateUnit: { fontSize: 11, color: colors.slate400 },
  empty: { textAlign: "center", color: colors.slate400, marginTop: 40, fontSize: 13 },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, paddingBottom: 28, maxHeight: "90%" },
  assignRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.slate100 },
  assignName: { flex: 1, fontSize: 15, fontWeight: "600", color: colors.slate900 },
  sheetTitle: { fontSize: 16, fontWeight: "800", color: colors.slate900, marginBottom: 12 },
  field: { marginBottom: 12 },
  fieldLabel: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginBottom: 6 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, backgroundColor: colors.bg, color: colors.slate900 },
  multiline: { minHeight: 56, textAlignVertical: "top" },
  segment: { flexDirection: "row", gap: 6, marginBottom: 12 },
  segItem: { flex: 1, paddingVertical: 9, borderRadius: 8, borderWidth: 1, borderColor: colors.border, alignItems: "center", backgroundColor: colors.bg },
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
