import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Alert, ActivityIndicator } from "react-native";
import { colors } from "../../lib/theme";
import { defaultPlantLine, loadPlant, logPlant, type PlantState } from "../../lib/plantUsage";

// Truck & plant on the Time tab (Stage 7, 31 Oct 2026): the driver logs a
// cartage run — hours and/or loads — against the job's cost centre, the
// Transport line by default for a vehicle. Big steppers, no typing: the crew
// are often in gloves. Names only; no costs on the phone.

function Stepper({ label, value, step, onChange }: { label: string; value: number; step: number; onChange: (v: number) => void }) {
  return (
    <View style={styles.stepper}>
      <Text style={styles.stepLabel}>{label}</Text>
      <View style={styles.stepRow}>
        <TouchableOpacity style={styles.stepBtn} onPress={() => onChange(Math.max(0, Math.round((value - step) * 10) / 10))} accessibilityLabel={`Less ${label}`}>
          <Text style={styles.stepBtnText}>−</Text>
        </TouchableOpacity>
        <Text style={styles.stepValue}>{value}</Text>
        <TouchableOpacity style={styles.stepBtn} onPress={() => onChange(Math.round((value + step) * 10) / 10)} accessibilityLabel={`More ${label}`}>
          <Text style={styles.stepBtnText}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

export function JobPlantUsage({ jobId }: { jobId: string }) {
  const [state, setState] = useState<PlantState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [equipmentId, setEquipmentId] = useState<string | null>(null);
  const [lineId, setLineId] = useState<string | null>(null);
  const [hours, setHours] = useState(0);
  const [loads, setLoads] = useState(0);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      setState(await loadPlant(jobId));
    } catch (e: any) {
      setError(e?.message ?? "Couldn't load truck and plant.");
    }
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  function pick(id: string) {
    setEquipmentId(id);
    const eq = state?.equipment.find((e) => e.id === id);
    setLineId(defaultPlantLine(eq?.category, state?.lines ?? []));
  }

  async function save() {
    if (!equipmentId) return Alert.alert("Pick the truck or machine");
    if (hours === 0 && loads === 0) return Alert.alert("Enter the hours, the loads, or both");
    setSaving(true);
    try {
      await logPlant(jobId, { equipmentId, hours, loads, costCenterId: lineId });
      setOpen(false);
      setEquipmentId(null);
      setLineId(null);
      setHours(0);
      setLoads(0);
      await load();
    } catch (e: any) {
      Alert.alert("Not saved", e?.message ?? "Try again.");
    } finally {
      setSaving(false);
    }
  }

  const lineName = (id: string | null) => (id ? state?.lines.find((l) => l.id === id)?.name ?? "cost centre" : "Not tagged");

  return (
    <View style={styles.card}>
      <Text style={styles.heading}>{"Truck & plant"}</Text>
      {error && (
        <TouchableOpacity onPress={load}>
          <Text style={styles.error}>{error} Tap to try again.</Text>
        </TouchableOpacity>
      )}
      {!state && !error && <ActivityIndicator color={colors.blue600} />}

      {state && !open && (
        <TouchableOpacity style={styles.addButton} onPress={() => setOpen(true)} accessibilityLabel="Log truck or plant">
          <Text style={styles.addButtonText}>+ Log truck / plant</Text>
        </TouchableOpacity>
      )}

      {state && open && (
        <View style={{ gap: 10 }}>
          <Text style={styles.label}>Truck or machine</Text>
          <View style={styles.chipRow}>
            {state.equipment.map((e) => (
              <TouchableOpacity key={e.id} style={[styles.chip, equipmentId === e.id && styles.chipActive]} onPress={() => pick(e.id)}>
                <Text style={[styles.chipText, equipmentId === e.id && styles.chipTextActive]}>{e.name}</Text>
              </TouchableOpacity>
            ))}
            {state.equipment.length === 0 && <Text style={styles.meta}>No trucks or plant set up yet. Ask the office.</Text>}
          </View>

          <Text style={styles.label}>Cost centre</Text>
          <View style={styles.chipRow}>
            {state.lines.map((l) => (
              <TouchableOpacity key={l.id} style={[styles.chip, lineId === l.id && styles.chipActive]} onPress={() => setLineId(l.id)}>
                <Text style={[styles.chipText, lineId === l.id && styles.chipTextActive]}>{l.name}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <View style={styles.stepPair}>
            <Stepper label="Hours" value={hours} step={0.5} onChange={setHours} />
            <Stepper label="Loads" value={loads} step={1} onChange={setLoads} />
          </View>

          <View style={styles.actions}>
            <TouchableOpacity style={styles.cancel} onPress={() => setOpen(false)}>
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.save} onPress={save} disabled={saving}>
              <Text style={styles.saveText}>{saving ? "Saving…" : "Save"}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {state?.usage.map((u) => (
        <Text key={u.id} style={styles.meta}>
          {[u.equipment, u.hours ? `${u.hours}h` : null, u.loads ? `${u.loads} load${u.loads === 1 ? "" : "s"}` : null, lineName(u.costCenterId), new Date(u.date).toLocaleDateString("en-AU"), u.loggedBy]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 16, marginBottom: 16, padding: 12, borderRadius: 12, backgroundColor: "#fff", borderWidth: 1, borderColor: colors.border, gap: 8 },
  heading: { fontSize: 13, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", letterSpacing: 0.5 },
  error: { fontSize: 13, color: colors.red600 },
  addButton: { paddingVertical: 14, borderRadius: 10, alignItems: "center", backgroundColor: colors.slate100 },
  addButtonText: { fontSize: 16, fontWeight: "700", color: colors.slate700 },
  label: { fontSize: 13, fontWeight: "700", color: colors.slate700 },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 999, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
  chipActive: { backgroundColor: colors.blue600, borderColor: colors.blue600 },
  chipText: { fontSize: 14, fontWeight: "600", color: colors.slate700 },
  chipTextActive: { color: "#fff" },
  stepPair: { flexDirection: "row", gap: 12 },
  stepper: { flex: 1, gap: 4 },
  stepLabel: { fontSize: 13, fontWeight: "700", color: colors.slate700 },
  stepRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderWidth: 1, borderColor: colors.border, borderRadius: 10 },
  stepBtn: { width: 52, height: 52, alignItems: "center", justifyContent: "center" },
  stepBtnText: { fontSize: 26, fontWeight: "700", color: colors.blue600 },
  stepValue: { fontSize: 20, fontWeight: "700", color: colors.slate900 },
  actions: { flexDirection: "row", gap: 10 },
  cancel: { flex: 1, paddingVertical: 14, borderRadius: 10, alignItems: "center", backgroundColor: colors.slate100 },
  cancelText: { fontSize: 16, fontWeight: "700", color: colors.slate700 },
  save: { flex: 2, paddingVertical: 14, borderRadius: 10, alignItems: "center", backgroundColor: colors.blue600 },
  saveText: { fontSize: 16, fontWeight: "700", color: "#fff" },
  meta: { fontSize: 12, color: colors.slate500 },
});
