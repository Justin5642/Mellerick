import { useCallback, useEffect, useState } from "react";
import { View, Text, FlatList, StyleSheet, RefreshControl, TouchableOpacity, Modal, TextInput, Alert, ScrollView, Switch } from "react-native";
import { Stack } from "expo-router";
import { colors } from "../lib/theme";
import { MoneyText } from "../design/components/MoneyText";
import { listStaff, saveStaff, type StaffMember } from "../lib/data/reads/staff";

const ROLES = ["technician", "office", "admin"] as const;
const roleColor: Record<string, { bg: string; text: string }> = {
  admin: { bg: colors.purple100, text: colors.purple700 },
  office: { bg: colors.blue100, text: colors.blue600 },
  technician: { bg: colors.slate100, text: colors.slate500 },
};

interface Draft {
  id: string;
  full_name: string;
  role: (typeof ROLES)[number];
  is_active: boolean;
  phone: string;
  hourly_rate: string;
  super_rate: string;
  workers_comp_rate: string;
  leave_loading_rate: string;
  annual_fixed_oncosts: string;
  target_hours_per_week: string;
  charge_out_rate: string;
}

function toDraft(s: StaffMember): Draft {
  const c = s.staff_cost_profiles;
  return {
    id: s.id,
    full_name: s.full_name,
    role: (s.role as Draft["role"]) ?? "technician",
    is_active: s.is_active,
    phone: s.phone ?? "",
    hourly_rate: String(c?.hourly_rate ?? 0),
    super_rate: String(c?.super_rate ?? 11.5),
    workers_comp_rate: String(c?.workers_comp_rate ?? 0),
    leave_loading_rate: String(c?.leave_loading_rate ?? 0),
    annual_fixed_oncosts: String(c?.annual_fixed_oncosts ?? 0),
    target_hours_per_week: String(c?.target_hours_per_week ?? 38),
    charge_out_rate: c?.charge_out_rate != null ? String(c.charge_out_rate) : "",
  };
}

export default function StaffScreen() {
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => setStaff(await listStaff()), []);
  useEffect(() => { load(); }, [load]);
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  async function save() {
    if (!draft || saving) return;
    const num = (s: string) => (s.trim() === "" ? 0 : parseFloat(s));
    setSaving(true);
    try {
      await saveStaff({
        id: draft.id,
        role: draft.role,
        isActive: draft.is_active,
        phone: draft.phone.trim() || null,
        cost: {
          hourly_rate: num(draft.hourly_rate),
          super_rate: num(draft.super_rate),
          workers_comp_rate: num(draft.workers_comp_rate),
          leave_loading_rate: num(draft.leave_loading_rate),
          annual_fixed_oncosts: num(draft.annual_fixed_oncosts),
          target_hours_per_week: num(draft.target_hours_per_week),
          // Blank clears the override (null) so the default charge-out applies.
          charge_out_rate: draft.charge_out_rate.trim() === "" ? null : parseFloat(draft.charge_out_rate),
        },
      });
      setDraft(null);
      await load();
    } catch {
      Alert.alert("Save failed", "Couldn't save — check your connection and try again.");
    } finally {
      setSaving(false);
    }
  }

  const set = (k: keyof Draft) => (v: string) => setDraft((d) => d && { ...d, [k]: v });

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: "Staff" }} />
      <FlatList
        data={staff}
        keyExtractor={(s) => s.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.blue600} />}
        ListEmptyComponent={<Text style={styles.empty}>No staff.</Text>}
        renderItem={({ item }) => {
          const rc = roleColor[item.role] ?? roleColor.technician;
          return (
            <TouchableOpacity style={styles.row} onPress={() => setDraft(toDraft(item))}>
              <View style={styles.body}>
                <View style={styles.nameRow}>
                  <Text style={[styles.name, !item.is_active && styles.inactive]} numberOfLines={1}>{item.full_name}</Text>
                  <View style={[styles.roleBadge, { backgroundColor: rc.bg }]}><Text style={[styles.roleText, { color: rc.text }]}>{item.role}</Text></View>
                  {!item.is_active && <Text style={styles.inactiveTag}>inactive</Text>}
                </View>
                <Text style={styles.email} numberOfLines={1}>{item.email}</Text>
              </View>
              <View style={styles.rateCol}>
                <MoneyText amount={item.staff_cost_profiles?.hourly_rate} style={styles.rate} />
                <Text style={styles.rateUnit}>/ hr</Text>
              </View>
            </TouchableOpacity>
          );
        }}
      />

      <Modal visible={!!draft} transparent animationType="slide" onRequestClose={() => !saving && setDraft(null)}>
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>{draft?.full_name}</Text>
            <ScrollView keyboardShouldPersistTaps="handled">
              <Text style={styles.fieldLabel}>Role</Text>
              <View style={styles.segment}>
                {ROLES.map((r) => (
                  <TouchableOpacity key={r} style={[styles.segItem, draft?.role === r && styles.segItemActive]} onPress={() => setDraft((d) => d && { ...d, role: r })}>
                    <Text style={[styles.segText, draft?.role === r && styles.segTextActive]}>{r}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={styles.switchRow}>
                <Text style={styles.switchLabel}>Active</Text>
                <Switch value={draft?.is_active ?? true} onValueChange={(v) => setDraft((d) => d && { ...d, is_active: v })} />
              </View>
              <Field label="Phone" value={draft?.phone ?? ""} onChange={set("phone")} />
              <Text style={styles.section}>Pay & on-costs</Text>
              <View style={styles.twoCol}>
                <View style={{ flex: 1 }}><Field label="Hourly rate ($)" value={draft?.hourly_rate ?? ""} onChange={set("hourly_rate")} num /></View>
                <View style={{ flex: 1 }}><Field label="Super (%)" value={draft?.super_rate ?? ""} onChange={set("super_rate")} num /></View>
              </View>
              <View style={styles.twoCol}>
                <View style={{ flex: 1 }}><Field label="Workers comp (%)" value={draft?.workers_comp_rate ?? ""} onChange={set("workers_comp_rate")} num /></View>
                <View style={{ flex: 1 }}><Field label="Leave loading (%)" value={draft?.leave_loading_rate ?? ""} onChange={set("leave_loading_rate")} num /></View>
              </View>
              <View style={styles.twoCol}>
                <View style={{ flex: 1 }}><Field label="Annual oncosts ($)" value={draft?.annual_fixed_oncosts ?? ""} onChange={set("annual_fixed_oncosts")} num /></View>
                <View style={{ flex: 1 }}><Field label="Target hrs/wk" value={draft?.target_hours_per_week ?? ""} onChange={set("target_hours_per_week")} num /></View>
              </View>
              <Field label="Charge-out rate ($/h, optional — blank = default)" value={draft?.charge_out_rate ?? ""} onChange={set("charge_out_rate")} num />
            </ScrollView>
            <View style={styles.actions}>
              <TouchableOpacity style={styles.cancel} onPress={() => setDraft(null)} disabled={saving}><Text style={styles.cancelText}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity style={styles.saveBtn} onPress={save} disabled={saving}><Text style={styles.saveText}>{saving ? "…" : "Save"}</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
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
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: colors.card, borderTopWidth: 1, borderTopColor: colors.border },
  body: { flex: 1, minWidth: 0 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { fontSize: 14, fontWeight: "600", color: colors.slate900 },
  inactive: { color: colors.slate400 },
  inactiveTag: { fontSize: 10, color: colors.slate400, fontStyle: "italic" },
  roleBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999 },
  roleText: { fontSize: 10, fontWeight: "700", textTransform: "capitalize" },
  email: { fontSize: 12, color: colors.slate500, marginTop: 2 },
  rateCol: { alignItems: "flex-end" },
  rate: { fontSize: 14, fontWeight: "700", color: colors.slate900 },
  rateUnit: { fontSize: 11, color: colors.slate400 },
  empty: { textAlign: "center", color: colors.slate400, marginTop: 40, fontSize: 13 },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, paddingBottom: 28, maxHeight: "88%" },
  sheetTitle: { fontSize: 16, fontWeight: "800", color: colors.slate900, marginBottom: 12 },
  section: { fontSize: 13, fontWeight: "700", color: colors.slate700, marginTop: 8, marginBottom: 6 },
  field: { marginBottom: 12 },
  fieldLabel: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginBottom: 6 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, backgroundColor: colors.bg, color: colors.slate900 },
  segment: { flexDirection: "row", gap: 8, marginBottom: 12 },
  segItem: { flex: 1, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: colors.border, alignItems: "center", backgroundColor: colors.bg },
  segItemActive: { backgroundColor: colors.blue600, borderColor: colors.blue600 },
  segText: { fontSize: 12, fontWeight: "600", color: colors.slate700, textTransform: "capitalize" },
  segTextActive: { color: "#fff" },
  switchRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 6, marginBottom: 6 },
  switchLabel: { fontSize: 14, fontWeight: "600", color: colors.slate700 },
  twoCol: { flexDirection: "row", gap: 12 },
  actions: { flexDirection: "row", gap: 10, marginTop: 12 },
  cancel: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.bg, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  cancelText: { color: colors.slate700, fontWeight: "600", fontSize: 14 },
  saveBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.blue600, alignItems: "center" },
  saveText: { color: "#fff", fontWeight: "700", fontSize: 14 },
});
