import { useCallback, useState } from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator, Alert, Linking } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../lib/supabase";
import { colors } from "../../lib/theme";
import {
  computeNextDueDate,
  getDueStatus,
  getDeviceTypeLabel,
  getWaterAuthorityLabel,
  DUE_STATUS_LABELS,
  DUE_STATUS_COLORS,
} from "../../lib/backflow";

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;

export default function BackflowDeviceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [device, setDevice] = useState<any>(null);
  const [tests, setTests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [openingId, setOpeningId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [{ data: deviceData }, { data: testsData }] = await Promise.all([
      supabase.from("backflow_devices").select("*, customers(name), sites(name, address_line1, suburb, state, postcode)").eq("id", id).single(),
      supabase
        .from("backflow_tests")
        .select("*, profiles!backflow_tests_tested_by_fkey(full_name)")
        .eq("device_id", id)
        .order("test_date", { ascending: false }),
    ]);
    setDevice(deviceData);
    setTests(testsData ?? []);
    setLoading(false);
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  async function viewCertificate(testId: string) {
    if (!API_BASE_URL) {
      Alert.alert("Not configured", "App isn't configured to reach the office server.");
      return;
    }
    setOpeningId(testId);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      const res = await fetch(`${API_BASE_URL}/api/backflow/tests/${testId}/certificate?json=1`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to open certificate");
      await Linking.openURL(data.signedUrl);
    } catch (e: any) {
      Alert.alert("Error", e?.message ?? "Failed to open certificate");
    } finally {
      setOpeningId(null);
    }
  }

  function formatDate(d: string | Date) {
    return new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
  }

  if (loading || !device) {
    return (
      <SafeAreaView style={styles.center} edges={["bottom", "left", "right"]}>
        <ActivityIndicator size="large" color={colors.blue600} />
      </SafeAreaView>
    );
  }

  const lastPass = tests.find((t) => t.result === "pass");
  const nextDueDate = computeNextDueDate(lastPass?.test_date, Number(device.test_frequency_months));
  const status = getDueStatus(nextDueDate);
  const sc = DUE_STATUS_COLORS[status];
  const address = device.sites
    ? [device.sites.address_line1, device.sites.suburb, device.sites.state, device.sites.postcode].filter(Boolean).join(", ")
    : null;

  return (
    <SafeAreaView style={styles.container} edges={["bottom", "left", "right"]}>
      <View style={styles.header}>
        <Text style={styles.title} numberOfLines={1}>
          {device.customers?.name ?? "Unknown customer"}
        </Text>
        <View style={[styles.badge, { backgroundColor: sc.bg }]}>
          <Text style={[styles.badgeText, { color: sc.text }]}>{DUE_STATUS_LABELS[status]}</Text>
        </View>
      </View>
      {address && <Text style={styles.subtitle}>{address}</Text>}
      <Text style={styles.subtitle}>{getWaterAuthorityLabel(device.water_authority)}</Text>

      <TouchableOpacity style={styles.logButton} onPress={() => router.push(`/backflow-test/${device.id}`)}>
        <Ionicons name="add-circle-outline" size={18} color="#fff" />
        <Text style={styles.logButtonText}>Log Test</Text>
      </TouchableOpacity>

      <ScrollView style={styles.content} contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Device Details</Text>
          <View style={styles.detailGrid}>
            <DetailItem label="Device Type" value={getDeviceTypeLabel(device.device_type)} />
            <DetailItem label="Make / Model" value={[device.make, device.model].filter(Boolean).join(" / ") || "—"} />
            <DetailItem label="Serial No." value={device.serial_number ?? "—"} />
            <DetailItem label="Size" value={device.size_mm ? `${device.size_mm} mm` : "—"} />
            <DetailItem label="Location" value={device.location_description ?? "—"} />
            <DetailItem label="Test Frequency" value={`Every ${device.test_frequency_months} months`} />
            <DetailItem label="Next Due" value={nextDueDate ? formatDate(nextDueDate) : "—"} />
            <DetailItem label="Water Meter No." value={device.water_meter_number ?? "—"} />
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Test History</Text>
          {tests.length === 0 && <Text style={styles.emptyText}>No tests logged yet</Text>}
          {tests.map((t) => (
            <View key={t.id} style={styles.testRow}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <View style={styles.testRowTitle}>
                  <Ionicons
                    name={t.result === "pass" ? "checkmark-circle" : "close-circle"}
                    size={15}
                    color={t.result === "pass" ? colors.green600 : colors.red600}
                  />
                  <Text style={styles.testDate} numberOfLines={1}>
                    {formatDate(t.test_date)} — {String(t.test_type).replace(/_/g, " ")}
                  </Text>
                </View>
                <Text style={styles.testMeta}>
                  Tested by {t.tester_name}
                  {t.profiles?.full_name ? ` (${t.profiles.full_name})` : ""}
                </Text>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                {t.submitted_to_water_authority_at ? (
                  <Text style={styles.submittedText}>Submitted to {getWaterAuthorityLabel(device.water_authority)}</Text>
                ) : (
                  <Text style={styles.notSubmittedText}>Not yet submitted</Text>
                )}
                {t.certificate_storage_path && (
                  <TouchableOpacity onPress={() => viewCertificate(t.id)} disabled={openingId === t.id} style={styles.pdfLink}>
                    <Ionicons name="document-text-outline" size={12} color={colors.blue600} />
                    <Text style={styles.pdfLinkText}>{openingId === t.id ? "Opening..." : "View PDF"}</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function DetailItem({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.detailItem}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 12,
    gap: 8,
  },
  title: { fontSize: 17, fontWeight: "700", color: colors.slate900, flex: 1 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  badgeText: { fontSize: 11, fontWeight: "600" },
  subtitle: { fontSize: 13, color: colors.slate500, paddingHorizontal: 16, marginTop: 2 },
  logButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: colors.blue600,
    borderRadius: 10,
    paddingVertical: 12,
    marginHorizontal: 16,
    marginTop: 14,
  },
  logButtonText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  content: { flex: 1, marginTop: 16 },
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
  detailGrid: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  detailItem: { width: "45%" },
  detailLabel: { fontSize: 10, fontWeight: "700", color: colors.slate400, textTransform: "uppercase" },
  detailValue: { fontSize: 13, color: colors.slate900, marginTop: 2 },
  emptyText: { fontSize: 13, color: colors.slate400 },
  testRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingVertical: 10,
  },
  testRowTitle: { flexDirection: "row", alignItems: "center", gap: 6 },
  testDate: { fontSize: 13, fontWeight: "600", color: colors.slate900, flexShrink: 1 },
  testMeta: { fontSize: 11, color: colors.slate500, marginTop: 2 },
  submittedText: { fontSize: 11, color: colors.green600, textAlign: "right" },
  notSubmittedText: { fontSize: 11, color: "#d97706", textAlign: "right" },
  pdfLink: { flexDirection: "row", alignItems: "center", gap: 3, marginTop: 4 },
  pdfLinkText: { fontSize: 11, color: colors.blue600, fontWeight: "600" },
});
