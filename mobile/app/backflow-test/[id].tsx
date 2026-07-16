import { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Modal,
  FlatList,
  Alert,
  Platform,
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import DateTimePicker, { DateTimePickerEvent } from "@react-native-community/datetimepicker";
import Signature, { SignatureViewRef } from "react-native-signature-canvas";
import { decode } from "base64-arraybuffer";
import { supabase } from "../../lib/supabase";
import { colors } from "../../lib/theme";
import { TEST_TYPES, FAILURE_REASONS } from "../../lib/backflow";

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;

interface DeviceGroup {
  group_label: string;
  make: string;
  model: string;
  serial_number: string;
  size_mm: string;
  check_valve_1_kpa: string;
  check_valve_1_leaked: boolean | null;
  check_valve_2_kpa: string;
  check_valve_2_leaked: boolean | null;
  upstream_isolation_valve_tight: boolean | null;
  downstream_isolation_valve_tight: boolean | null;
  relief_valve_opened: boolean | null;
}

const GROUP_LABELS = ["Main Device", "By-pass Device", "PVB / SPVB / AVB"];

function emptyGroup(label: string): DeviceGroup {
  return {
    group_label: label,
    make: "",
    model: "",
    serial_number: "",
    size_mm: "",
    check_valve_1_kpa: "",
    check_valve_1_leaked: null,
    check_valve_2_kpa: "",
    check_valve_2_leaked: null,
    upstream_isolation_valve_tight: null,
    downstream_isolation_valve_tight: null,
    relief_valve_opened: null,
  };
}

function toIsoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}
function formatDateShort(d: Date) {
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

// Yes/No toggle -- two buttons, tri-state (tapping the already-selected one
// clears back to null), matching the web form's YesNoField behaviour.
function ToggleField({
  label,
  value,
  onChange,
  yesLabel = "Yes",
  noLabel = "No",
}: {
  label?: string;
  value: boolean | null;
  onChange: (v: boolean | null) => void;
  yesLabel?: string;
  noLabel?: string;
}) {
  return (
    <View style={styles.fieldGroup}>
      {label ? <Text style={styles.fieldLabel}>{label}</Text> : null}
      <View style={styles.toggleRow}>
        <TouchableOpacity
          style={[styles.toggleButton, value === true && styles.toggleButtonActive]}
          onPress={() => onChange(value === true ? null : true)}
        >
          <Text style={[styles.toggleButtonText, value === true && styles.toggleButtonTextActive]}>{yesLabel}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.toggleButton, value === false && styles.toggleButtonActiveRed]}
          onPress={() => onChange(value === false ? null : false)}
        >
          <Text style={[styles.toggleButtonText, value === false && styles.toggleButtonTextActive]}>{noLabel}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// Tap-to-open bottom-sheet list -- same reasoning as time.tsx's
// CostCenterPicker: avoids the inline wheel picker changing values as the
// user scrolls past it.
function ModalPicker({
  label,
  value,
  options,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TouchableOpacity style={styles.selectField} onPress={() => setOpen(true)}>
        <Text style={[styles.selectFieldText, !current && styles.selectFieldPlaceholder]} numberOfLines={1}>
          {current ? current.label : placeholder ?? "Select..."}
        </Text>
        <Ionicons name="chevron-down" size={14} color={colors.slate400} />
      </TouchableOpacity>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setOpen(false)}>
          <View style={styles.modalSheet}>
            <Text style={styles.modalTitle}>{label}</Text>
            <FlatList
              data={options}
              keyExtractor={(o) => o.value}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.modalRow}
                  onPress={() => {
                    onChange(item.value);
                    setOpen(false);
                  }}
                >
                  <Text style={[styles.modalRowText, value === item.value && styles.modalRowTextActive]}>{item.label}</Text>
                  {value === item.value && <Ionicons name="checkmark" size={18} color={colors.blue600} />}
                </TouchableOpacity>
              )}
            />
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

function DateField({ label, value, onChange }: { label: string; value: Date; onChange: (d: Date) => void }) {
  const [show, setShow] = useState(false);
  function onPickerChange(event: DateTimePickerEvent, selected?: Date) {
    setShow(Platform.OS === "ios" ? show : false);
    if (event.type === "dismissed" || !selected) return;
    onChange(selected);
  }
  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TouchableOpacity style={styles.selectField} onPress={() => setShow((s) => !s)}>
        <Text style={styles.selectFieldText}>{formatDateShort(value)}</Text>
        <Ionicons name="calendar-outline" size={14} color={colors.slate400} />
      </TouchableOpacity>
      {show && <DateTimePicker value={value} mode="date" display={Platform.OS === "ios" ? "spinner" : "default"} onChange={onPickerChange} />}
    </View>
  );
}

export default function NewBackflowTestScreen() {
  const { id: deviceId } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const signatureRef = useRef<SignatureViewRef>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [testType, setTestType] = useState("annual");
  const [testDate, setTestDate] = useState(new Date());
  const [permissionToTurnOffWater, setPermissionToTurnOffWater] = useState<boolean | null>(null);
  const [mainsPressureKpa, setMainsPressureKpa] = useState("");
  const [groups, setGroups] = useState<DeviceGroup[]>([emptyGroup("Main Device")]);
  const [strainerInstalled, setStrainerInstalled] = useState<boolean | null>(null);
  const [strainerCleaned, setStrainerCleaned] = useState<boolean | null>(null);
  const [isolatingValvesPadlocked, setIsolatingValvesPadlocked] = useState<boolean | null>(null);
  const [compliesWithAsNzs, setCompliesWithAsNzs] = useState<boolean | null>(null);
  const [result, setResult] = useState<"pass" | "fail">("pass");
  const [reasonForFailure, setReasonForFailure] = useState("");
  const [repairScheduledDate, setRepairScheduledDate] = useState<Date | null>(null);
  const [testKitSerialNumber, setTestKitSerialNumber] = useState("");
  const [testKitCalibrationDate, setTestKitCalibrationDate] = useState<Date | null>(null);
  const [testerName, setTesterName] = useState("");
  const [testerLicenceNumber, setTesterLicenceNumber] = useState("");
  const [testerPhone, setTesterPhone] = useState("");
  const [remarks, setRemarks] = useState("");

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setCurrentUserId(data.user?.id ?? null);
      if (data.user) {
        supabase
          .from("profiles")
          .select("full_name")
          .eq("id", data.user.id)
          .single()
          .then(({ data: profile }) => {
            if (profile?.full_name) setTesterName(profile.full_name);
          });
      }
    });
  }, []);

  function updateGroup(index: number, patch: Partial<DeviceGroup>) {
    setGroups((prev) => prev.map((g, i) => (i === index ? { ...g, ...patch } : g)));
  }
  function addGroup() {
    if (groups.length >= 3) return;
    setGroups((prev) => [...prev, emptyGroup(GROUP_LABELS[prev.length] ?? `Device ${prev.length + 1}`)]);
  }
  function removeGroup(index: number) {
    setGroups((prev) => prev.filter((_, i) => i !== index));
  }

  function validate(): string | null {
    if (!testerName.trim()) return "Authorised tester's name is required";
    if (result === "fail" && !reasonForFailure) return "Select a reason for failure";
    return null;
  }

  function handleSavePress() {
    const err = validate();
    if (err) {
      Alert.alert("Missing info", err);
      return;
    }
    if (saving) return;
    // Triggers onOK (if the pad has strokes) or onEmpty (if it's blank) below
    // — either way we proceed to submit, since the signature is optional
    // here (unlike the customer sign-off flow on the jobs side).
    signatureRef.current?.readSignature();
  }

  async function submitTest(signatureBase64: string | null) {
    setSaving(true);
    try {
      let signatureStoragePath: string | null = null;
      if (signatureBase64) {
        const base64 = signatureBase64.replace(/^data:image\/png;base64,/, "");
        const path = `${deviceId}/signatures/${Date.now()}.png`;
        const { error: uploadError } = await supabase.storage.from("backflow-certificates").upload(path, decode(base64), {
          contentType: "image/png",
        });
        if (!uploadError) signatureStoragePath = path;
      }

      const testResults = groups.map((g) => ({
        group_label: g.group_label,
        make: g.make || null,
        model: g.model || null,
        serial_number: g.serial_number || null,
        size_mm: g.size_mm ? Number(g.size_mm) : null,
        check_valve_1_kpa: g.check_valve_1_kpa ? Number(g.check_valve_1_kpa) : null,
        check_valve_1_leaked: g.check_valve_1_leaked,
        check_valve_2_kpa: g.check_valve_2_kpa ? Number(g.check_valve_2_kpa) : null,
        check_valve_2_leaked: g.check_valve_2_leaked,
        upstream_isolation_valve_tight: g.upstream_isolation_valve_tight,
        downstream_isolation_valve_tight: g.downstream_isolation_valve_tight,
        relief_valve_opened: g.relief_valve_opened,
      }));

      const { data: test, error } = await supabase
        .from("backflow_tests")
        .insert({
          device_id: deviceId,
          test_type: testType,
          test_date: toIsoDate(testDate),
          result,
          mains_pressure_kpa: mainsPressureKpa ? Number(mainsPressureKpa) : null,
          permission_to_turn_off_water: permissionToTurnOffWater,
          strainer_installed: strainerInstalled,
          strainer_cleaned: strainerCleaned,
          isolating_valves_padlocked: isolatingValvesPadlocked,
          complies_with_as_nzs_3500_1: compliesWithAsNzs,
          reason_for_failure: result === "fail" ? reasonForFailure : null,
          repair_scheduled_date: result === "fail" && repairScheduledDate ? toIsoDate(repairScheduledDate) : null,
          test_kit_serial_number: testKitSerialNumber || null,
          test_kit_calibration_date: testKitCalibrationDate ? toIsoDate(testKitCalibrationDate) : null,
          tester_name: testerName,
          tester_licence_number: testerLicenceNumber || null,
          tester_phone: testerPhone || null,
          remarks: remarks || null,
          test_results: testResults,
          signature_storage_path: signatureStoragePath,
          tested_by: currentUserId,
        })
        .select("id")
        .single();

      if (error || !test) {
        Alert.alert("Error", error?.message ?? "Failed to save test");
        setSaving(false);
        return;
      }

      if (!API_BASE_URL) {
        Alert.alert("Test logged", "Test saved, but the app isn't configured to reach the office server to submit it. Submit from the office dashboard.");
        router.replace(`/backflow/${deviceId}`);
        return;
      }

      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const accessToken = sessionData.session?.access_token;
        const res = await fetch(`${API_BASE_URL}/api/backflow/tests/${test.id}/submit`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error ?? "Submission failed");
        Alert.alert("Test submitted", `Report emailed to ${data.sentTo}`);
      } catch (err: any) {
        Alert.alert("Test saved", `Test saved, but submission failed: ${err?.message ?? "unknown error"} — retry from the device page.`);
      }

      router.replace(`/backflow/${deviceId}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <SafeAreaView style={styles.container} edges={["bottom", "left", "right"]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Ionicons name="arrow-back" size={18} color={colors.slate500} />
          <Text style={styles.backButtonText}>Back</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Log Backflow Test</Text>
      </View>

      <ScrollView style={styles.content} contentContainerStyle={{ paddingBottom: 60 }}>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Test Details</Text>
          <ModalPicker label="Test Type" value={testType} options={TEST_TYPES} onChange={setTestType} />
          <DateField label="Date of Test" value={testDate} onChange={setTestDate} />
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Mains Pressure (kPa)</Text>
            <TextInput style={styles.input} value={mainsPressureKpa} onChangeText={setMainsPressureKpa} keyboardType="decimal-pad" />
          </View>
          <ToggleField label="Permission Received to Turn Off Water" value={permissionToTurnOffWater} onChange={setPermissionToTurnOffWater} />
        </View>

        <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <Text style={styles.cardTitle}>Device Test Results</Text>
            {groups.length < 3 && (
              <TouchableOpacity style={styles.addGroupButton} onPress={addGroup}>
                <Ionicons name="add" size={14} color={colors.blue600} />
                <Text style={styles.addGroupButtonText}>Add Group</Text>
              </TouchableOpacity>
            )}
          </View>
          {groups.map((g, i) => (
            <View key={i} style={styles.groupBox}>
              <View style={styles.cardHeaderRow}>
                <Text style={styles.groupLabel}>{g.group_label}</Text>
                {groups.length > 1 && (
                  <TouchableOpacity onPress={() => removeGroup(i)}>
                    <Ionicons name="trash-outline" size={16} color={colors.slate400} />
                  </TouchableOpacity>
                )}
              </View>
              <View style={styles.groupGrid}>
                <View style={styles.groupGridItem}>
                  <Text style={styles.fieldLabelSm}>Make</Text>
                  <TextInput style={styles.input} value={g.make} onChangeText={(v) => updateGroup(i, { make: v })} />
                </View>
                <View style={styles.groupGridItem}>
                  <Text style={styles.fieldLabelSm}>Model</Text>
                  <TextInput style={styles.input} value={g.model} onChangeText={(v) => updateGroup(i, { model: v })} />
                </View>
                <View style={styles.groupGridItem}>
                  <Text style={styles.fieldLabelSm}>Serial No.</Text>
                  <TextInput style={styles.input} value={g.serial_number} onChangeText={(v) => updateGroup(i, { serial_number: v })} />
                </View>
                <View style={styles.groupGridItem}>
                  <Text style={styles.fieldLabelSm}>Size (mm)</Text>
                  <TextInput style={styles.input} value={g.size_mm} onChangeText={(v) => updateGroup(i, { size_mm: v })} keyboardType="decimal-pad" />
                </View>
              </View>

              <Text style={styles.fieldLabelSm}>Check Valve 1 (kPa)</Text>
              <TextInput
                style={styles.input}
                value={g.check_valve_1_kpa}
                onChangeText={(v) => updateGroup(i, { check_valve_1_kpa: v })}
                keyboardType="decimal-pad"
              />
              <ToggleField
                value={g.check_valve_1_leaked}
                onChange={(v) => updateGroup(i, { check_valve_1_leaked: v })}
                yesLabel="Leaked"
                noLabel="Closed tight"
              />

              <Text style={styles.fieldLabelSm}>Check Valve 2 (kPa)</Text>
              <TextInput
                style={styles.input}
                value={g.check_valve_2_kpa}
                onChangeText={(v) => updateGroup(i, { check_valve_2_kpa: v })}
                keyboardType="decimal-pad"
              />
              <ToggleField
                value={g.check_valve_2_leaked}
                onChange={(v) => updateGroup(i, { check_valve_2_leaked: v })}
                yesLabel="Leaked"
                noLabel="Closed tight"
              />

              <ToggleField
                label="Upstream Isolation Valve"
                value={g.upstream_isolation_valve_tight}
                onChange={(v) => updateGroup(i, { upstream_isolation_valve_tight: v })}
                yesLabel="Tight"
                noLabel="Leaked"
              />
              <ToggleField
                label="Downstream Isolation Valve"
                value={g.downstream_isolation_valve_tight}
                onChange={(v) => updateGroup(i, { downstream_isolation_valve_tight: v })}
                yesLabel="Tight"
                noLabel="Leaked"
              />
              <ToggleField
                label="Relief Valve"
                value={g.relief_valve_opened}
                onChange={(v) => updateGroup(i, { relief_valve_opened: v })}
                yesLabel="Opened"
                noLabel="Didn't open"
              />
            </View>
          ))}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Compliance &amp; Result</Text>
          <ToggleField label="Strainer Installed" value={strainerInstalled} onChange={setStrainerInstalled} />
          <ToggleField label="Strainer Cleaned" value={strainerCleaned} onChange={setStrainerCleaned} />
          <ToggleField label="Isolating Valves Padlocked" value={isolatingValvesPadlocked} onChange={setIsolatingValvesPadlocked} />
          <ToggleField label="Complies with AS/NZS3500.1" value={compliesWithAsNzs} onChange={setCompliesWithAsNzs} />

          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Device Test Result</Text>
            <View style={styles.toggleRow}>
              <TouchableOpacity
                style={[styles.resultButton, result === "pass" && styles.resultButtonPass]}
                onPress={() => setResult("pass")}
              >
                <Text style={[styles.toggleButtonText, result === "pass" && styles.toggleButtonTextActive]}>Pass</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.resultButton, result === "fail" && styles.resultButtonFail]}
                onPress={() => setResult("fail")}
              >
                <Text style={[styles.toggleButtonText, result === "fail" && styles.toggleButtonTextActive]}>Fail</Text>
              </TouchableOpacity>
            </View>
          </View>

          {result === "fail" && (
            <View style={styles.failBox}>
              <ModalPicker
                label="Reason for Failure"
                value={reasonForFailure}
                options={FAILURE_REASONS.map((r) => ({ value: r, label: r }))}
                placeholder="Select reason"
                onChange={setReasonForFailure}
              />
              <DateField label="Repair Scheduled Date" value={repairScheduledDate ?? new Date()} onChange={setRepairScheduledDate} />
            </View>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Test Kit &amp; Authorised Tester</Text>
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Test Kit Serial No.</Text>
            <TextInput style={styles.input} value={testKitSerialNumber} onChangeText={setTestKitSerialNumber} />
          </View>
          <DateField label="Test Kit Calibration Date" value={testKitCalibrationDate ?? new Date()} onChange={setTestKitCalibrationDate} />
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Authorised Tester's Name *</Text>
            <TextInput style={styles.input} value={testerName} onChangeText={setTesterName} />
          </View>
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Licence No.</Text>
            <TextInput style={styles.input} value={testerLicenceNumber} onChangeText={setTesterLicenceNumber} />
          </View>
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Phone</Text>
            <TextInput style={styles.input} value={testerPhone} onChangeText={setTesterPhone} keyboardType="phone-pad" />
          </View>
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Remarks</Text>
            <TextInput style={[styles.input, styles.textArea]} value={remarks} onChangeText={setRemarks} multiline />
          </View>

          <View style={styles.fieldGroup}>
            <View style={styles.cardHeaderRow}>
              <Text style={styles.fieldLabel}>Signature</Text>
              <TouchableOpacity onPress={() => signatureRef.current?.clearSignature()}>
                <Text style={styles.clearText}>Clear</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.canvasWrap}>
              <Signature
                ref={signatureRef}
                onOK={(sig) => submitTest(sig)}
                onEmpty={() => submitTest(null)}
                descriptionText=""
                clearText="Clear"
                confirmText="Confirm"
                webStyle={signatureWebStyle}
                autoClear={false}
              />
            </View>
          </View>
        </View>

        <TouchableOpacity style={styles.submitButton} onPress={handleSavePress} disabled={saving}>
          {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitButtonText}>Save &amp; Submit to Water Authority</Text>}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const signatureWebStyle = `
  .m-signature-pad--footer { display: flex; justify-content: space-between; padding: 8px; }
  .m-signature-pad--body { border: none; }
  body,html { background-color: #f8fafc; }
`;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 },
  backButton: { flexDirection: "row", alignItems: "center", gap: 4 },
  backButtonText: { color: colors.slate500, fontSize: 13, fontWeight: "500" },
  title: { fontSize: 17, fontWeight: "700", color: colors.slate900 },
  content: { flex: 1, marginTop: 6 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    marginHorizontal: 16,
    marginBottom: 14,
  },
  cardTitle: { fontSize: 14, fontWeight: "700", color: colors.slate700, marginBottom: 10 },
  cardHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  fieldGroup: { marginBottom: 14 },
  fieldLabel: { fontSize: 12, fontWeight: "600", color: colors.slate700, marginBottom: 6 },
  fieldLabelSm: { fontSize: 11, fontWeight: "600", color: colors.slate500, marginBottom: 4, marginTop: 8 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    backgroundColor: colors.bg,
    color: colors.slate900,
  },
  textArea: { minHeight: 70, textAlignVertical: "top" },
  toggleRow: { flexDirection: "row", gap: 8 },
  toggleButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    alignItems: "center",
  },
  toggleButtonActive: { backgroundColor: colors.blue600, borderColor: colors.blue600 },
  toggleButtonActiveRed: { backgroundColor: colors.red600, borderColor: colors.red600 },
  toggleButtonText: { fontSize: 13, fontWeight: "600", color: colors.slate700 },
  toggleButtonTextActive: { color: "#fff" },
  resultButton: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    alignItems: "center",
  },
  resultButtonPass: { backgroundColor: colors.green600, borderColor: colors.green600 },
  resultButtonFail: { backgroundColor: colors.red600, borderColor: colors.red600 },
  selectField: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    backgroundColor: colors.bg,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  selectFieldText: { fontSize: 14, color: colors.slate900, flexShrink: 1, marginRight: 6 },
  selectFieldPlaceholder: { color: colors.slate400 },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" },
  modalSheet: { backgroundColor: colors.card, borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingBottom: 24, maxHeight: "60%" },
  modalTitle: { fontSize: 13, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", padding: 16, paddingBottom: 8 },
  modalRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  modalRowText: { fontSize: 15, color: colors.slate900, flex: 1, marginRight: 8 },
  modalRowTextActive: { color: colors.blue600, fontWeight: "600" },
  groupBox: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12, marginBottom: 12 },
  groupLabel: { fontSize: 13, fontWeight: "700", color: colors.slate700 },
  groupGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  groupGridItem: { width: "47%" },
  addGroupButton: { flexDirection: "row", alignItems: "center", gap: 4 },
  addGroupButtonText: { fontSize: 12, fontWeight: "600", color: colors.blue600 },
  failBox: { backgroundColor: colors.red100, borderRadius: 10, padding: 12, marginTop: 4 },
  clearText: { fontSize: 12, color: colors.blue600, fontWeight: "600" },
  canvasWrap: { height: 180, borderWidth: 2, borderColor: colors.border, borderRadius: 12, overflow: "hidden", backgroundColor: colors.bg },
  submitButton: {
    backgroundColor: colors.blue600,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginHorizontal: 16,
    marginTop: 4,
  },
  submitButtonText: { color: "#fff", fontWeight: "600", fontSize: 15 },
});
