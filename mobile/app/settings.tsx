import { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, RefreshControl, TouchableOpacity, Modal, TextInput, Switch, Alert } from "react-native";
import { Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../lib/supabase";
import { colors } from "../lib/theme";
import { MoneyText } from "../design/components/MoneyText";
import { useSettings } from "../lib/data/hooks/useSettings";
import { listVariationTypes, listCostCentreTemplates, type VariationType, type CostCentreTemplate } from "../lib/data/reads/settings";

interface Integrations {
  xero: string | null; // tenant name, or null
  google: boolean;
}

async function readIntegrations(): Promise<Integrations> {
  const [xeroRes, googleRes] = await Promise.all([
    supabase.from("xero_tokens").select("tenant_name").limit(1).maybeSingle(),
    supabase.from("google_tokens").select("id").limit(1).maybeSingle(),
  ]);
  return {
    xero: (xeroRes.data as { tenant_name: string } | null)?.tenant_name ?? null,
    google: !!googleRes.data,
  };
}

interface VtDraft { id: string | null; name: string; unit: string; rate: string; autoApprove: boolean }
interface CcDraft { groupName: string; name: string; code: string }

export default function SettingsScreen() {
  const settings = useSettings();
  const [state, setState] = useState<Integrations | null>(null);
  const [vTypes, setVTypes] = useState<VariationType[]>([]);
  const [costCentres, setCostCentres] = useState<CostCentreTemplate[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [draft, setDraft] = useState<VtDraft | null>(null);
  const [ccDraft, setCcDraft] = useState<CcDraft | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [i, vt, cc] = await Promise.all([readIntegrations(), listVariationTypes(), listCostCentreTemplates()]);
      setState(i);
      setVTypes(vt);
      setCostCentres(cc);
    } catch {
      setState({ xero: null, google: false });
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

  async function saveVt() {
    if (!draft || saving || !settings.ready) return;
    const rate = parseFloat(draft.rate);
    if (!draft.name.trim() || Number.isNaN(rate)) { Alert.alert("Missing details", "Name and a numeric rate are required."); return; }
    setSaving(true);
    try {
      const input = { name: draft.name.trim(), unit: draft.unit.trim() || "each", rate, autoApprove: draft.autoApprove };
      if (draft.id) await settings.updateVariationType(draft.id, input);
      else await settings.createVariationType(input);
      setDraft(null);
      await load();
    } catch (e) {
      Alert.alert("Couldn't save", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(vt: VariationType) {
    try {
      await settings.setVariationTypeActive(vt.id, !vt.is_active);
      setVTypes((prev) => prev.map((v) => (v.id === vt.id ? { ...v, is_active: !v.is_active } : v)));
    } catch (e) {
      Alert.alert("Couldn't update", e instanceof Error ? e.message : "Please try again.");
    }
  }

  async function saveCc() {
    if (!ccDraft || saving || !settings.ready) return;
    if (!ccDraft.groupName.trim() || !ccDraft.name.trim()) { Alert.alert("Missing details", "Group and stage name are required."); return; }
    setSaving(true);
    try {
      await settings.createCostCentreTemplate({ groupName: ccDraft.groupName.trim(), name: ccDraft.name.trim(), code: ccDraft.code.trim() || null });
      setCcDraft(null);
      await load();
    } catch (e) {
      Alert.alert("Couldn't save", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setSaving(false);
    }
  }
  async function toggleCc(cc: CostCentreTemplate) {
    try {
      await settings.setCostCentreTemplateActive(cc.id, !cc.is_active);
      setCostCentres((prev) => prev.map((c) => (c.id === cc.id ? { ...c, is_active: !c.is_active } : c)));
    } catch (e) {
      Alert.alert("Couldn't update", e instanceof Error ? e.message : "Please try again.");
    }
  }
  const ccGroups = Array.from(new Set(costCentres.map((c) => c.group_name)));

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.blue600} />}>
      <Stack.Screen options={{ title: "Settings" }} />
      <Text style={styles.section}>Integrations</Text>
      {state === null ? (
        <ActivityIndicator color={colors.blue600} style={{ marginTop: 20 }} />
      ) : (
        <>
          <IntegrationRow icon="cash-outline" name="Xero" connected={!!state.xero} detail={state.xero ? `Connected · ${state.xero}` : "Not connected"} />
          <IntegrationRow icon="calendar-outline" name="Google Calendar" connected={state.google} detail={state.google ? "Connected" : "Not connected"} />
        </>
      )}
      <View style={styles.noteCard}>
        <Ionicons name="information-circle-outline" size={18} color={colors.slate500} />
        <Text style={styles.noteText}>
          Connecting or disconnecting integrations uses a secure browser sign-in and is managed on the web dashboard. This screen shows current status.
        </Text>
      </View>

      <View style={styles.sectionHead}>
        <Text style={styles.section}>Variation types</Text>
        <TouchableOpacity onPress={() => setDraft({ id: null, name: "", unit: "m³", rate: "", autoApprove: true })} style={styles.addBtn}>
          <Ionicons name="add" size={16} color={colors.blue600} /><Text style={styles.addText}>Add</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.card}>
        {vTypes.length === 0 ? <Text style={styles.empty}>No variation types yet.</Text> : vTypes.map((vt) => (
          <View key={vt.id} style={[styles.vtRow, !vt.is_active && styles.vtInactive]}>
            <TouchableOpacity style={{ flex: 1 }} onPress={() => setDraft({ id: vt.id, name: vt.name, unit: vt.unit, rate: String(vt.rate), autoApprove: vt.auto_approve })}>
              <Text style={styles.vtName}>{vt.name}{vt.is_active ? "" : " · inactive"}</Text>
              <Text style={styles.vtMeta}>per {vt.unit}{vt.auto_approve ? " · auto-approves" : ""}</Text>
            </TouchableOpacity>
            <MoneyText amount={vt.rate} style={styles.vtRate} />
            <TouchableOpacity onPress={() => toggleActive(vt)} hitSlop={8} style={styles.vtToggle}>
              <Ionicons name={vt.is_active ? "eye-off-outline" : "refresh-outline"} size={18} color={colors.slate400} />
            </TouchableOpacity>
          </View>
        ))}
      </View>
      <Text style={styles.hint}>Tap a type to edit its rate; the eye toggles it active/inactive.</Text>

      <View style={styles.sectionHead}>
        <Text style={styles.section}>Cost-centre templates</Text>
        <TouchableOpacity onPress={() => setCcDraft({ groupName: ccGroups[0] ?? "", name: "", code: "" })} style={styles.addBtn}>
          <Ionicons name="add" size={16} color={colors.blue600} /><Text style={styles.addText}>Add</Text>
        </TouchableOpacity>
      </View>
      <View style={styles.card}>
        {costCentres.length === 0 ? <Text style={styles.empty}>No templates yet.</Text> : ccGroups.map((g) => (
          <View key={g}>
            <Text style={styles.ccGroup}>{g}</Text>
            {costCentres.filter((c) => c.group_name === g).map((cc) => (
              <View key={cc.id} style={[styles.vtRow, !cc.is_active && styles.vtInactive]}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.vtName}>{cc.name}{cc.is_active ? "" : " · inactive"}</Text>
                  {cc.code ? <Text style={styles.vtMeta}>{cc.code}</Text> : null}
                </View>
                <TouchableOpacity onPress={() => toggleCc(cc)} hitSlop={8} style={styles.vtToggle}>
                  <Ionicons name={cc.is_active ? "eye-off-outline" : "refresh-outline"} size={18} color={colors.slate400} />
                </TouchableOpacity>
              </View>
            ))}
          </View>
        ))}
      </View>
      <Text style={styles.hint}>Xero account codes are configured on the web dashboard.</Text>

      <Modal visible={!!draft} transparent animationType="slide" onRequestClose={() => !saving && setDraft(null)}>
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>{draft?.id ? "Edit variation type" : "New variation type"}</Text>
            <Field label="Name" value={draft?.name ?? ""} onChange={(v) => setDraft((d) => d && { ...d, name: v })} />
            <View style={styles.twoCol}>
              <View style={{ flex: 1 }}><Field label="Unit" value={draft?.unit ?? ""} onChange={(v) => setDraft((d) => d && { ...d, unit: v })} /></View>
              <View style={{ flex: 1 }}><Field label="Rate ($/unit)" value={draft?.rate ?? ""} onChange={(v) => setDraft((d) => d && { ...d, rate: v })} num /></View>
            </View>
            <View style={styles.switchRow}>
              <Text style={styles.switchLabel}>Auto-approve</Text>
              <Switch value={draft?.autoApprove ?? true} onValueChange={(v) => setDraft((d) => d && { ...d, autoApprove: v })} />
            </View>
            <View style={styles.actions}>
              <TouchableOpacity style={styles.cancel} onPress={() => setDraft(null)} disabled={saving}><Text style={styles.cancelText}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity style={styles.saveBtn} onPress={saveVt} disabled={saving}><Text style={styles.saveText}>{saving ? "…" : "Save"}</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal visible={!!ccDraft} transparent animationType="slide" onRequestClose={() => !saving && setCcDraft(null)}>
        <View style={styles.overlay}>
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>New cost-centre stage</Text>
            <Field label="Group (e.g. Excavation)" value={ccDraft?.groupName ?? ""} onChange={(v) => setCcDraft((d) => d && { ...d, groupName: v })} />
            <Field label="Stage name" value={ccDraft?.name ?? ""} onChange={(v) => setCcDraft((d) => d && { ...d, name: v })} />
            <Field label="Code (optional)" value={ccDraft?.code ?? ""} onChange={(v) => setCcDraft((d) => d && { ...d, code: v })} />
            <View style={styles.actions}>
              <TouchableOpacity style={styles.cancel} onPress={() => setCcDraft(null)} disabled={saving}><Text style={styles.cancelText}>Cancel</Text></TouchableOpacity>
              <TouchableOpacity style={styles.saveBtn} onPress={saveCc} disabled={saving}><Text style={styles.saveText}>{saving ? "…" : "Save"}</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollView>
  );
}

function IntegrationRow({ icon, name, connected, detail }: { icon: keyof typeof Ionicons.glyphMap; name: string; connected: boolean; detail: string }) {
  return (
    <View style={styles.row}>
      <View style={[styles.iconWrap, connected ? styles.iconOn : styles.iconOff]}>
        <Ionicons name={icon} size={20} color={connected ? colors.green600 : colors.slate400} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.name}>{name}</Text>
        <Text style={[styles.detail, connected && styles.detailOn]}>{detail}</Text>
      </View>
      <View style={[styles.dot, { backgroundColor: connected ? colors.green600 : colors.slate400 }]} />
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
  content: { padding: 16, paddingBottom: 40 },
  section: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginBottom: 8, marginLeft: 4 },
  sectionHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 18 },
  addBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
  addText: { fontSize: 13, color: colors.blue600, fontWeight: "600" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 14, marginBottom: 8 },
  iconWrap: { width: 40, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  iconOn: { backgroundColor: colors.green100 },
  iconOff: { backgroundColor: colors.slate100 },
  name: { fontSize: 15, fontWeight: "700", color: colors.slate900 },
  detail: { fontSize: 12, color: colors.slate400, marginTop: 2 },
  detailOn: { color: colors.green600 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  noteCard: { flexDirection: "row", gap: 10, backgroundColor: colors.slate100, borderRadius: 12, padding: 14, marginTop: 10 },
  noteText: { flex: 1, fontSize: 12, color: colors.slate500, lineHeight: 18 },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12, marginTop: 8 },
  empty: { fontSize: 13, color: colors.slate400, paddingVertical: 8, textAlign: "center" },
  ccGroup: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginTop: 10, marginBottom: 2 },
  vtRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.slate100 },
  vtInactive: { opacity: 0.55 },
  vtName: { fontSize: 14, fontWeight: "600", color: colors.slate900 },
  vtMeta: { fontSize: 12, color: colors.slate500, marginTop: 1 },
  vtRate: { fontSize: 14, fontWeight: "700", color: colors.slate900 },
  vtToggle: { padding: 4 },
  hint: { fontSize: 11, color: colors.slate400, marginLeft: 4, marginTop: 8, lineHeight: 15 },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  sheet: { backgroundColor: colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, paddingBottom: 28 },
  sheetTitle: { fontSize: 16, fontWeight: "800", color: colors.slate900, marginBottom: 12 },
  field: { marginBottom: 12 },
  fieldLabel: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginBottom: 6 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, backgroundColor: colors.bg, color: colors.slate900 },
  twoCol: { flexDirection: "row", gap: 12 },
  switchRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 6 },
  switchLabel: { fontSize: 14, fontWeight: "600", color: colors.slate700 },
  actions: { flexDirection: "row", gap: 10, marginTop: 14 },
  cancel: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.bg, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  cancelText: { color: colors.slate700, fontWeight: "600", fontSize: 14 },
  saveBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.blue600, alignItems: "center" },
  saveText: { color: "#fff", fontWeight: "700", fontSize: 14 },
});
