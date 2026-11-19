import { useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, TextInput, Alert, ActivityIndicator, Switch } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { KeyboardSheet, KEYBOARD_SHEET_INPUT_FONT_SIZE } from "../KeyboardSheet";
import { MoneyText } from "../../design/components/MoneyText";
import { RoleGate } from "../../design/guards/RoleGate";
import { cryptoIdGen } from "../../lib/data/ids";
import { DEFAULT_COST_CENTRE_BY_TYPE, HIRE_TYPE_LABELS, HIRE_UNITS_BY_TYPE, HIRE_UNIT_LABELS, floatMoveCharge, type HireType } from "../../lib/hireLabels";
import { blankHireRow, hireFormRow, hireSetupProblem, loadHireSetup, saveHireSetup, withHireType, type HireFormRow } from "../../lib/fleetOffice";

// Fleet → Hire setup for one machine on the phone (office/admin): the web's
// components/fleet/equipment-hire-dialog.tsx. How the machine is charged as
// Day Works, ex GST; for a truck, Cartage per tonne / per m³ / per km are what
// its truck loads are charged at. Online only (rates are office-only by RLS
// and in no PowerSync stream).

export function HireSetupSheet({
  equipmentId,
  equipmentName,
  visible,
  onClose,
  onSaved,
}: {
  equipmentId: string;
  equipmentName: string;
  visible: boolean;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const [rows, setRows] = useState<HireFormRow[] | null>(null);
  const [centres, setCentres] = useState<{ id: string; name: string }[]>([]);
  const [notOn, setNotOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [centreFor, setCentreFor] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    let live = true;
    setRows(null);
    setError(null);
    setNotOn(false);
    loadHireSetup(equipmentId)
      .then((s) => {
        if (!live) return;
        setNotOn(!s.ready);
        setCentres(s.costCentres);
        setRows(s.options.length > 0 ? s.options.map(hireFormRow) : [blankHireRow(cryptoIdGen.newId())]);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "Couldn't load the hire setup."));
    return () => { live = false; };
  }, [visible, equipmentId]);

  const set = (key: string, patch: Partial<HireFormRow>) => setRows((rs) => rs && rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  async function save() {
    if (!rows || saving) return;
    const problem = hireSetupProblem(rows);
    if (problem) { Alert.alert("Check the hire setup", problem); return; }
    setSaving(true);
    try {
      await saveHireSetup(equipmentId, rows);
      onSaved?.();
      onClose();
    } catch (e) {
      Alert.alert("Couldn't save the hire setup", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const centreName = (r: HireFormRow) => centres.find((c) => c.id === r.cost_centre_id)?.name ?? `Default (${DEFAULT_COST_CENTRE_BY_TYPE[r.hire_type]})`;

  return (
    <RoleGate roles={["office", "admin"]}>
      <KeyboardSheet
        visible={visible}
        onRequestClose={() => !saving && onClose()}
        title={<Text style={styles.title}>{equipmentName} — Hire setup</Text>}
        footer={
          <View style={styles.actions}>
            <TouchableOpacity style={styles.cancel} onPress={onClose} disabled={saving}><Text style={styles.cancelText}>Cancel</Text></TouchableOpacity>
            <TouchableOpacity style={[styles.saveBtn, (!rows || notOn || saving) && styles.disabled]} onPress={save} disabled={!rows || notOn || saving}>
              <Text style={styles.saveText}>{saving ? "Saving…" : "Save"}</Text>
            </TouchableOpacity>
          </View>
        }
      >
        {error ? (
          <Text style={styles.empty}>{error}</Text>
        ) : !rows ? (
          <ActivityIndicator color={colors.blue600} />
        ) : notOn ? (
          <Text style={styles.empty}>Day Works / Hire isn&apos;t switched on in this database yet.</Text>
        ) : (
          <>
            <Text style={styles.hint}>
              How this machine is charged as Day Works, ex GST. Operator labour is costed separately and is not in these rates. For a truck, Cartage per tonne / per m³ and per km are the rates its truck loads are charged at.
            </Text>
            {rows.map((r) => (
              <View key={r.key} style={styles.block}>
                <Text style={styles.label}>Hire type</Text>
                <View style={styles.chips}>
                  {(Object.keys(HIRE_TYPE_LABELS) as HireType[]).map((t) => (
                    <Chip key={t} label={HIRE_TYPE_LABELS[t]} active={r.hire_type === t} onPress={() => setRows((rs) => rs && rs.map((x) => (x.key === r.key ? withHireType(x, t) : x)))} />
                  ))}
                </View>
                {HIRE_UNITS_BY_TYPE[r.hire_type].length > 1 && (
                  <>
                    <Text style={styles.label}>Charged</Text>
                    <View style={styles.chips}>
                      {HIRE_UNITS_BY_TYPE[r.hire_type].map((u) => (
                        <Chip key={u} label={HIRE_UNIT_LABELS[u]} active={r.hire_unit === u} onPress={() => set(r.key, { hire_unit: u })} />
                      ))}
                    </View>
                  </>
                )}
                <Text style={styles.label}>Cost centre</Text>
                <TouchableOpacity style={styles.select} onPress={() => setCentreFor(centreFor === r.key ? null : r.key)}>
                  <Text style={styles.selectText}>{centreName(r)}</Text>
                  <Ionicons name={centreFor === r.key ? "chevron-up" : "chevron-down"} size={16} color={colors.slate500} />
                </TouchableOpacity>
                {centreFor === r.key && (
                  <View style={styles.centreList}>
                    {[{ id: "", name: `Default (${DEFAULT_COST_CENTRE_BY_TYPE[r.hire_type]})` }, ...centres].map((c) => (
                      <TouchableOpacity key={c.id || "default"} style={styles.centreRow} onPress={() => { set(r.key, { cost_centre_id: c.id }); setCentreFor(null); }}>
                        <Text style={styles.centreText}>{c.name}</Text>
                        {r.cost_centre_id === c.id && <Ionicons name="checkmark" size={16} color={colors.blue600} />}
                      </TouchableOpacity>
                    ))}
                  </View>
                )}

                {r.hire_type === "float" ? (
                  <>
                    <View style={styles.threeCol}>
                      <NumField label="Base $" value={r.float_base} onChange={(v) => set(r.key, { float_base: v })} />
                      <NumField label="Km in base" value={r.float_km_included} onChange={(v) => set(r.key, { float_km_included: v })} />
                      <NumField label="$ / km beyond" value={r.float_per_km} onChange={(v) => set(r.key, { float_per_km: v })} />
                    </View>
                    <View style={styles.example}>
                      <Text style={styles.hintInline}>Loaded leg only. e.g. 50 km = </Text>
                      <MoneyText amount={floatMoveCharge(50, r)} style={styles.hintInline} />
                    </View>
                  </>
                ) : (
                  <>
                    <NumField label={`Rate $ ${HIRE_UNIT_LABELS[r.hire_unit]}`} value={r.rate} onChange={(v) => set(r.key, { rate: v })} />
                    <Toggle label="Fuel included" value={r.fuel_included} onChange={(v) => set(r.key, { fuel_included: v })} />
                    {r.hire_unit === "day" && <Toggle label="Full days only" value={r.whole_days_only} onChange={(v) => set(r.key, { whole_days_only: v })} />}
                  </>
                )}
                <TextInput style={styles.input} value={r.notes} onChangeText={(v) => set(r.key, { notes: v })} placeholder="Notes (optional)" placeholderTextColor={colors.slate400} />
                <View style={styles.rowEnd}>
                  <Toggle label="Offered" value={r.is_active} onChange={(v) => set(r.key, { is_active: v })} />
                  <TouchableOpacity onPress={() => setRows((rs) => rs && rs.filter((x) => x.key !== r.key))} accessibilityLabel="Remove this way of hiring" hitSlop={8}>
                    <Ionicons name="trash-outline" size={18} color={colors.slate400} />
                  </TouchableOpacity>
                </View>
              </View>
            ))}
            <Text style={styles.hint}>Removing a way of hiring leaves any Day Works lines entered under it without a rate — switch off &ldquo;Offered&rdquo; instead to stop new ones.</Text>
            <TouchableOpacity style={styles.addRow} onPress={() => setRows((rs) => [...(rs ?? []), blankHireRow(cryptoIdGen.newId())])}>
              <Ionicons name="add" size={16} color={colors.blue600} /><Text style={styles.addText}>Another way to hire it</Text>
            </TouchableOpacity>
          </>
        )}
      </KeyboardSheet>
    </RoleGate>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={[styles.chip, active && styles.chipActive]} onPress={onPress}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function NumField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput style={styles.input} value={value} onChangeText={onChange} keyboardType="decimal-pad" placeholderTextColor={colors.slate400} />
    </View>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={styles.toggle}>
      <Switch value={value} onValueChange={onChange} />
      <Text style={styles.toggleText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 16, fontWeight: "800", color: colors.slate900 },
  empty: { fontSize: 13, color: colors.slate500, paddingVertical: 12, textAlign: "center" },
  hint: { fontSize: 12, color: colors.slate500, marginBottom: 10 },
  hintInline: { fontSize: 12, color: colors.slate500 },
  example: { flexDirection: "row", flexWrap: "wrap", marginBottom: 10 },
  block: { borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12, marginBottom: 12 },
  label: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginBottom: 6 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  chipActive: { backgroundColor: colors.blue600, borderColor: colors.blue600 },
  chipText: { fontSize: 12, fontWeight: "600", color: colors.slate700 },
  chipTextActive: { color: "#fff" },
  select: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: colors.bg, marginBottom: 10 },
  selectText: { fontSize: 14, color: colors.slate900 },
  centreList: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, marginBottom: 10 },
  centreRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.slate100 },
  centreText: { fontSize: 14, color: colors.slate700 },
  field: { flex: 1, marginBottom: 10 },
  threeCol: { flexDirection: "row", gap: 8 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: KEYBOARD_SHEET_INPUT_FONT_SIZE, backgroundColor: colors.bg, color: colors.slate900 },
  toggle: { flexDirection: "row", alignItems: "center", gap: 8, marginVertical: 6 },
  toggleText: { fontSize: 14, color: colors.slate700 },
  rowEnd: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 6 },
  addRow: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 8 },
  addText: { fontSize: 13, color: colors.blue600, fontWeight: "600" },
  actions: { flexDirection: "row", gap: 10 },
  cancel: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.bg, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  cancelText: { color: colors.slate700, fontWeight: "600", fontSize: 14 },
  saveBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.blue600, alignItems: "center" },
  saveText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  disabled: { opacity: 0.5 },
});
