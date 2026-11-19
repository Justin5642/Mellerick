import { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, TouchableOpacity, TextInput, Alert, RefreshControl, Switch } from "react-native";
import { Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { KeyboardSheet, KEYBOARD_SHEET_INPUT_FONT_SIZE } from "../../components/KeyboardSheet";
import { HireSetupSheet } from "../../components/fleet/HireSetupSheet";
import { MoneyText } from "../../design/components/MoneyText";
import { RoleGate } from "../../design/guards/RoleGate";
import { addHireAttachment, loadHireRates, updateHireAttachment, type HireAttachment, type HireRates } from "../../lib/fleetOffice";

// Fleet → Hire rates on the phone (office/admin; registered only in the office
// route group). The web's components/fleet/fleet-hire-rates.tsx and
// hire-attachments.tsx: every machine Day Works lists with its rates, unpriced
// first ("No hire rate yet" — it can't be picked in Day Works until set up),
// each opening Hire setup; and the attachments with their day rates. Online
// only — the rate tables are office-only by RLS and in no PowerSync stream.

export default function HireRatesScreen() {
  const [data, setData] = useState<HireRates | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [setupFor, setSetupFor] = useState<{ id: string; name: string } | null>(null);
  const [editing, setEditing] = useState<{ a: HireAttachment; rate: string; active: boolean } | null>(null);
  const [newName, setNewName] = useState("");
  const [newRate, setNewRate] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      setData(await loadHireRates());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the hire rates.");
    } finally {
      setRefreshing(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function add() {
    if (busy) return;
    if (!newName.trim()) { Alert.alert("Missing name", "Name the attachment."); return; }
    const rate = Number(newRate || 0);
    if (!Number.isFinite(rate) || rate < 0) { Alert.alert("Check the day rate", "The day rate must be a number, zero or more."); return; }
    setBusy(true);
    try {
      await addHireAttachment(newName.trim(), String(rate));
      setNewName("");
      setNewRate("");
      await load();
    } catch (e) {
      Alert.alert("Couldn't add the attachment", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function saveAttachment() {
    if (!editing || busy) return;
    const rate = Number(editing.rate || 0);
    if (!Number.isFinite(rate) || rate < 0) { Alert.alert("Check the day rate", "The day rate must be a number, zero or more."); return; }
    setBusy(true);
    try {
      await updateHireAttachment(editing.a.id, { day_rate: rate, is_active: editing.active });
      setEditing(null);
      await load();
    } catch (e) {
      Alert.alert("Couldn't save the attachment", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <RoleGate roles={["office", "admin"]} fallback={<View style={styles.center}><Text style={styles.muted}>Office only.</Text></View>}>
      <Stack.Screen options={{ title: "Hire rates" }} />
      {!data && !error ? (
        <View style={styles.center}><ActivityIndicator size="large" color={colors.blue600} /></View>
      ) : (
        <ScrollView
          style={styles.container}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={colors.blue600} />}
        >
          {error ? (
            <View style={styles.card}>
              <Text style={styles.muted}>{error}</Text>
              <TouchableOpacity onPress={() => void load()}><Text style={styles.retry}>Try again</Text></TouchableOpacity>
            </View>
          ) : data && !data.ready ? (
            <View style={styles.card}><Text style={styles.muted}>Day Works / Hire isn&apos;t switched on in this database yet.</Text></View>
          ) : data ? (
            <>
              <Text style={styles.intro}>
                Day Works rates per machine, ex GST. Operator labour is costed separately.{" "}
                {data.rows.length === 0 ? "No active machines in the register." : data.missing > 0
                  ? `${data.missing === 1 ? "1 machine has" : `${data.missing} machines have`} no hire rate yet — ${data.missing === 1 ? "it can't" : "they can't"} be picked in Day Works.`
                  : "Every machine has a hire rate."}
              </Text>
              <View style={styles.card}>
                {data.rows.map((m) => (
                  <View key={m.id} style={styles.row}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.name}>{m.name}</Text>
                      {m.options.length === 0 ? (
                        <Text style={styles.noRate}>No hire rate yet</Text>
                      ) : (
                        m.options.map((o, i) => (
                          <Text key={i} style={[styles.meta, !o.active && styles.off]}>
                            {o.label}: {o.rateText}{o.active ? "" : " (not offered)"}
                          </Text>
                        ))
                      )}
                    </View>
                    <TouchableOpacity style={styles.smallBtn} onPress={() => setSetupFor({ id: m.id, name: m.name })}>
                      <Text style={styles.smallBtnText}>{m.hasRate ? "Edit" : "Set up"}</Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </View>

              <Text style={styles.section}>Attachments</Text>
              <Text style={styles.intro}>Charged a full day (ex GST) on Day Works whenever they are on a machine.</Text>
              <View style={styles.card}>
                {data.attachments.length === 0 && <Text style={styles.muted}>No attachments yet.</Text>}
                {data.attachments.map((a) => (
                  <TouchableOpacity key={a.id} style={styles.row} onPress={() => setEditing({ a, rate: String(a.day_rate ?? 0), active: a.is_active })}>
                    <Text style={[styles.name, { flex: 1 }, !a.is_active && styles.off]}>{a.name}</Text>
                    <MoneyText amount={Number(a.day_rate)} style={styles.rate} />
                    <Text style={styles.meta}> / day</Text>
                    <Ionicons name="create-outline" size={16} color={colors.slate400} style={{ marginLeft: 8 }} />
                  </TouchableOpacity>
                ))}
                <View style={styles.addRow}>
                  <TextInput style={[styles.input, { flex: 1 }]} value={newName} onChangeText={setNewName} placeholder="e.g. Rock breaker" placeholderTextColor={colors.slate400} />
                  <TextInput style={[styles.input, { width: 90 }]} value={newRate} onChangeText={setNewRate} keyboardType="decimal-pad" placeholder="$ / day" placeholderTextColor={colors.slate400} />
                  <TouchableOpacity style={styles.addBtn} onPress={add} disabled={busy} accessibilityLabel="Add attachment">
                    <Ionicons name="add" size={20} color="#fff" />
                  </TouchableOpacity>
                </View>
              </View>
            </>
          ) : null}
        </ScrollView>
      )}

      {setupFor && (
        <HireSetupSheet
          equipmentId={setupFor.id}
          equipmentName={setupFor.name}
          visible={!!setupFor}
          onClose={() => setSetupFor(null)}
          onSaved={() => void load()}
        />
      )}

      <KeyboardSheet
        visible={!!editing}
        onRequestClose={() => !busy && setEditing(null)}
        title={<Text style={styles.sheetTitle}>{editing?.a.name}</Text>}
        footer={
          <View style={styles.actions}>
            <TouchableOpacity style={styles.cancel} onPress={() => setEditing(null)} disabled={busy}><Text style={styles.cancelText}>Cancel</Text></TouchableOpacity>
            <TouchableOpacity style={styles.saveBtn} onPress={saveAttachment} disabled={busy}><Text style={styles.saveText}>{busy ? "…" : "Save"}</Text></TouchableOpacity>
          </View>
        }
      >
        <Text style={styles.label}>Day rate ($, ex GST)</Text>
        <TextInput style={styles.input} value={editing?.rate ?? ""} onChangeText={(v) => setEditing((e) => e && { ...e, rate: v })} keyboardType="decimal-pad" />
        <View style={styles.toggle}>
          <Switch value={editing?.active ?? true} onValueChange={(v) => setEditing((e) => e && { ...e, active: v })} />
          <Text style={styles.toggleText}>Offered</Text>
        </View>
      </KeyboardSheet>
    </RoleGate>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 40 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  muted: { fontSize: 13, color: colors.slate500, textAlign: "center", paddingVertical: 8 },
  retry: { fontSize: 13, color: colors.blue600, fontWeight: "600", textAlign: "center" },
  intro: { fontSize: 12, color: colors.slate500, marginBottom: 8 },
  section: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginTop: 20, marginBottom: 6, marginLeft: 4 },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.slate100 },
  name: { fontSize: 14, fontWeight: "600", color: colors.slate900 },
  meta: { fontSize: 12, color: colors.slate500, marginTop: 1 },
  off: { color: colors.slate400, textDecorationLine: "line-through" },
  noRate: { fontSize: 12, color: colors.orange700, fontWeight: "600", marginTop: 1 },
  rate: { fontSize: 14, fontWeight: "700", color: colors.slate900 },
  smallBtn: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, borderWidth: 1, borderColor: colors.blue600, backgroundColor: colors.blue100 },
  smallBtnText: { fontSize: 12, fontWeight: "700", color: colors.blue600 },
  addRow: { flexDirection: "row", gap: 8, alignItems: "center", marginTop: 10 },
  addBtn: { width: 44, height: 44, borderRadius: 10, backgroundColor: colors.blue600, alignItems: "center", justifyContent: "center" },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: KEYBOARD_SHEET_INPUT_FONT_SIZE, backgroundColor: colors.bg, color: colors.slate900 },
  label: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginBottom: 6 },
  toggle: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 12 },
  toggleText: { fontSize: 14, color: colors.slate700 },
  sheetTitle: { fontSize: 16, fontWeight: "800", color: colors.slate900 },
  actions: { flexDirection: "row", gap: 10 },
  cancel: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.bg, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  cancelText: { color: colors.slate700, fontWeight: "600", fontSize: 14 },
  saveBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.blue600, alignItems: "center" },
  saveText: { color: "#fff", fontWeight: "700", fontSize: 14 },
});
