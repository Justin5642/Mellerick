import { useEffect, useState } from "react";
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
  ActivityIndicator,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { supabase } from "../../lib/supabase";
import { colors } from "../../lib/theme";
import { WATER_AUTHORITIES, DEVICE_TYPES, PROTECTION_TYPES } from "../../lib/backflow";

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;
const NO_SITE_VALUE = "__no_site__";

// Tap-to-open bottom-sheet list -- same pattern as backflow-test/[id].tsx's
// ModalPicker (avoids the inline wheel picker changing values as the user
// scrolls past it).
function ModalPicker({
  label,
  value,
  options,
  placeholder,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  placeholder?: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <View style={styles.fieldGroup}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TouchableOpacity
        style={[styles.selectField, disabled && styles.selectFieldDisabled]}
        onPress={() => !disabled && setOpen(true)}
        disabled={disabled}
      >
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

export default function NewBackflowDeviceScreen() {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [sites, setSites] = useState<{ id: string; name: string; suburb: string }[]>([]);

  const [customerId, setCustomerId] = useState("");
  const [siteId, setSiteId] = useState("");
  const [waterAuthority, setWaterAuthority] = useState("");
  const [testFrequencyMonths, setTestFrequencyMonths] = useState("12");
  const [waterAuthorityPropertyNumber, setWaterAuthorityPropertyNumber] = useState("");
  const [waterMeterNumber, setWaterMeterNumber] = useState("");
  const [fireServiceMeterNumber, setFireServiceMeterNumber] = useState("");
  const [deviceType, setDeviceType] = useState("");
  const [protectionType, setProtectionType] = useState("");
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [sizeMm, setSizeMm] = useState("");
  const [locationDescription, setLocationDescription] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    supabase
      .from("customers")
      .select("id, name")
      .eq("is_active", true)
      .order("name")
      .then(({ data }) => setCustomers(data ?? []));
  }, []);

  useEffect(() => {
    if (!customerId) {
      setSites([]);
      setSiteId("");
      return;
    }
    supabase
      .from("sites")
      .select("id, name, suburb")
      .eq("customer_id", customerId)
      .then(({ data }) => setSites(data ?? []));
  }, [customerId]);

  async function scanDataPlate() {
    if (!API_BASE_URL) {
      Alert.alert("Not configured", "App isn't configured to reach the office server.");
      return;
    }
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Permission needed", "Camera access is required");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.7, base64: true });
    if (result.canceled || !result.assets?.length || !result.assets[0].base64) return;

    setScanning(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      const res = await fetch(`${API_BASE_URL}/api/backflow/scan-data-plate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ imageBase64: result.assets[0].base64, mimeType: "image/jpeg" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to read data plate");

      const r = data.result as {
        make: string | null;
        model: string | null;
        serial_number: string | null;
        size_mm: number | null;
        device_type: string | null;
        additional_details: string | null;
      };

      const found: string[] = [];
      if (r.make) { setMake(r.make); found.push("make"); }
      if (r.model) { setModel(r.model); found.push("model"); }
      if (r.serial_number) { setSerialNumber(r.serial_number); found.push("serial no."); }
      if (r.size_mm) { setSizeMm(String(r.size_mm)); found.push("size"); }
      if (r.device_type) { setDeviceType(r.device_type); found.push("device type"); }
      if (r.additional_details) {
        setNotes((prev) => (prev ? `${prev}\n\n${r.additional_details}` : (r.additional_details as string)));
      }

      if (found.length === 0) {
        Alert.alert("Nothing legible", "Couldn't read anything confidently off that plate — try a clearer, straighter-on photo.");
      } else {
        Alert.alert("Plate read", `Filled in ${found.join(", ")}. Double-check before saving.`);
      }
    } catch (err: any) {
      Alert.alert("Scan failed", err?.message ?? "Failed to read data plate");
    } finally {
      setScanning(false);
    }
  }

  async function handleSave() {
    if (!customerId || !waterAuthority || !deviceType) {
      Alert.alert("Missing info", "Customer, water authority, and device type are required");
      return;
    }
    if (
      !waterAuthorityPropertyNumber ||
      !protectionType ||
      !make ||
      !model ||
      !serialNumber ||
      !sizeMm ||
      !locationDescription
    ) {
      Alert.alert(
        "Missing info",
        "Water authority property no., protection type, make, model, serial no., size, and location are all required — the water authority will reject a certificate missing these."
      );
      return;
    }
    setSaving(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      const payload = {
        customer_id: customerId,
        site_id: siteId || null,
        water_authority: waterAuthority,
        device_type: deviceType,
        protection_type: protectionType || null,
        make: make || null,
        model: model || null,
        serial_number: serialNumber || null,
        size_mm: sizeMm ? Number(sizeMm) : null,
        location_description: locationDescription || null,
        water_authority_property_number: waterAuthorityPropertyNumber || null,
        water_meter_number: waterMeterNumber || null,
        fire_service_meter_number: fireServiceMeterNumber || null,
        test_frequency_months: Number(testFrequencyMonths) || 12,
        notes: notes || null,
        created_by: userData.user?.id ?? null,
      };
      const { data, error } = await supabase.from("backflow_devices").insert(payload).select("id").single();
      if (error || !data) {
        Alert.alert("Error", error?.message ?? "Failed to register device");
        return;
      }
      router.replace(`/backflow/${data.id}`);
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
        <Text style={styles.title}>Register Device</Text>
      </View>

      <ScrollView style={styles.content} contentContainerStyle={{ paddingBottom: 60 }}>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Property &amp; Authority</Text>
          <ModalPicker
            label="Customer *"
            value={customerId}
            options={customers.map((c) => ({ value: c.id, label: c.name }))}
            placeholder="Select customer"
            onChange={setCustomerId}
          />
          <ModalPicker
            label="Site"
            value={siteId || NO_SITE_VALUE}
            options={[{ value: NO_SITE_VALUE, label: "No specific site" }, ...sites.map((s) => ({ value: s.id, label: `${s.name} — ${s.suburb}` }))]}
            placeholder={customerId ? "Select site (optional)" : "Select customer first"}
            onChange={(v) => setSiteId(v === NO_SITE_VALUE ? "" : v)}
            disabled={!customerId}
          />
          <ModalPicker
            label="Water Authority *"
            value={waterAuthority}
            options={WATER_AUTHORITIES.map((w) => ({ value: w.value, label: w.label }))}
            placeholder="Select water authority"
            onChange={setWaterAuthority}
          />
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Test Frequency (months)</Text>
            <TextInput style={styles.input} value={testFrequencyMonths} onChangeText={setTestFrequencyMonths} keyboardType="number-pad" />
          </View>
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Water Authority Property No. *</Text>
            <TextInput style={styles.input} value={waterAuthorityPropertyNumber} onChangeText={setWaterAuthorityPropertyNumber} />
          </View>
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Water Meter No.</Text>
            <TextInput style={styles.input} value={waterMeterNumber} onChangeText={setWaterMeterNumber} />
          </View>
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Fire Service Meter No.</Text>
            <TextInput style={styles.input} value={fireServiceMeterNumber} onChangeText={setFireServiceMeterNumber} />
          </View>
        </View>

        <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <Text style={styles.cardTitle}>Device Details</Text>
            <TouchableOpacity style={styles.scanButton} onPress={scanDataPlate} disabled={scanning}>
              {scanning ? <ActivityIndicator size="small" color={colors.blue600} /> : <Ionicons name="camera-outline" size={16} color={colors.blue600} />}
              <Text style={styles.scanButtonText}>{scanning ? "Reading plate..." : "Scan Data Plate"}</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.hintText}>
            Snap the device&apos;s data plate to auto-fill make, model, serial, size and device type — every plate is different, so review before saving.
          </Text>

          <ModalPicker
            label="Device Type *"
            value={deviceType}
            options={DEVICE_TYPES.map((d) => ({ value: d.value, label: d.label }))}
            placeholder="Select device type"
            onChange={setDeviceType}
          />
          <ModalPicker
            label="Protection Type *"
            value={protectionType}
            options={PROTECTION_TYPES.map((p) => ({ value: p.value, label: p.label }))}
            placeholder="Select protection type"
            onChange={setProtectionType}
          />
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Make *</Text>
            <TextInput style={styles.input} value={make} onChangeText={setMake} />
          </View>
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Model *</Text>
            <TextInput style={styles.input} value={model} onChangeText={setModel} />
          </View>
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Serial No. *</Text>
            <TextInput style={styles.input} value={serialNumber} onChangeText={setSerialNumber} />
          </View>
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Size (mm) *</Text>
            <TextInput style={styles.input} value={sizeMm} onChangeText={setSizeMm} keyboardType="decimal-pad" />
          </View>
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Location of Device *</Text>
            <TextInput style={styles.input} value={locationDescription} onChangeText={setLocationDescription} placeholder="e.g. Boundary, front garden" />
          </View>
          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>Notes</Text>
            <TextInput style={[styles.input, styles.textArea]} value={notes} onChangeText={setNotes} multiline />
          </View>
        </View>

        <TouchableOpacity style={styles.submitButton} onPress={handleSave} disabled={saving}>
          {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.submitButtonText}>Register Device</Text>}
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

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
  cardHeaderRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 4 },
  hintText: { fontSize: 11, color: colors.slate400, marginBottom: 10 },
  scanButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderColor: colors.blue600,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  scanButtonText: { fontSize: 12, fontWeight: "600", color: colors.blue600 },
  fieldGroup: { marginBottom: 14 },
  fieldLabel: { fontSize: 12, fontWeight: "600", color: colors.slate700, marginBottom: 6 },
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
  selectFieldDisabled: { opacity: 0.5 },
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
