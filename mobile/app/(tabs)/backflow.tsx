import { useCallback, useState } from "react";
import { View, Text, Image, StyleSheet, FlatList, TouchableOpacity, RefreshControl, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../lib/supabase";
import { colors } from "../../lib/theme";
import {
  computeNextDueDate,
  getDueStatus,
  getWaterAuthorityLabel,
  DUE_STATUS_LABELS,
  DUE_STATUS_COLORS,
  DueStatus,
} from "../../lib/backflow";

interface Device {
  id: string;
  water_authority: string;
  serial_number: string | null;
  test_frequency_months: number;
  customers: { name: string } | null;
  sites: { name: string; suburb: string } | null;
  backflow_tests: { test_date: string; result: string }[];
}

const STATUS_ORDER: Record<DueStatus, number> = { overdue: 0, due_soon: 1, no_test: 2, ok: 3 };

export default function BackflowScreen() {
  const router = useRouter();
  const [rows, setRows] = useState<{ device: Device; nextDueDate: Date | null; status: DueStatus }[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("backflow_devices")
      .select("id, water_authority, serial_number, test_frequency_months, customers(name), sites(name, suburb), backflow_tests(test_date, result)")
      .eq("is_active", true)
      .order("created_at", { ascending: false });

    const computed: { device: Device; nextDueDate: Date | null; status: DueStatus }[] = (((data as any) ?? []) as Device[]).map((device) => {
      const passingTests = (device.backflow_tests ?? []).filter((t) => t.result === "pass");
      const lastPass = passingTests.sort((a, b) => (a.test_date < b.test_date ? 1 : -1))[0];
      const nextDueDate = computeNextDueDate(lastPass?.test_date, Number(device.test_frequency_months));
      const status = getDueStatus(nextDueDate);
      return { device, nextDueDate, status };
    });
    computed.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || (a.nextDueDate?.getTime() ?? 0) - (b.nextDueDate?.getTime() ?? 0));

    setRows(computed);
    setLoading(false);
    setRefreshing(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  function onRefresh() {
    setRefreshing(true);
    load();
  }

  function formatDate(d: Date) {
    return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
  }

  const overdueCount = rows.filter((r) => r.status === "overdue").length;
  const dueSoonCount = rows.filter((r) => r.status === "due_soon").length;

  if (loading) {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator size="large" color={colors.blue600} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Image source={require("../../assets/logo.png")} style={styles.headerLogo} resizeMode="contain" />
          <View>
            <Text style={styles.headerTitle}>Backflow Testing</Text>
            <Text style={styles.headerSubtitle}>
              {rows.length} device{rows.length !== 1 ? "s" : ""}
              {overdueCount > 0 ? ` · ${overdueCount} overdue` : ""}
              {dueSoonCount > 0 ? ` · ${dueSoonCount} due soon` : ""}
            </Text>
          </View>
        </View>
        <TouchableOpacity style={styles.addButton} onPress={() => router.push("/backflow/new")}>
          <Ionicons name="add" size={22} color="#fff" />
        </TouchableOpacity>
      </View>

      <FlatList
        data={rows}
        keyExtractor={(r) => r.device.id}
        contentContainerStyle={styles.listContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        ListEmptyComponent={<Text style={styles.emptyText}>No backflow devices registered yet.</Text>}
        renderItem={({ item }) => {
          const sc = DUE_STATUS_COLORS[item.status];
          return (
            <TouchableOpacity style={styles.card} onPress={() => router.push(`/backflow/${item.device.id}`)}>
              <View style={styles.cardHeader}>
                <Text style={styles.cardTitle} numberOfLines={1}>
                  {item.device.customers?.name ?? "Unknown customer"}
                </Text>
                <View style={[styles.badge, { backgroundColor: sc.bg }]}>
                  <Text style={[styles.badgeText, { color: sc.text }]}>{DUE_STATUS_LABELS[item.status]}</Text>
                </View>
              </View>
              <View style={styles.cardMetaRow}>
                {item.device.sites?.suburb && (
                  <Text style={styles.cardMeta}>
                    <Ionicons name="location-outline" size={12} color={colors.slate400} /> {item.device.sites.suburb}
                  </Text>
                )}
                <Text style={styles.cardMeta}>{getWaterAuthorityLabel(item.device.water_authority)}</Text>
                {item.device.serial_number && <Text style={styles.cardMeta}>S/N {item.device.serial_number}</Text>}
              </View>
              <Text style={styles.cardDue}>
                {item.nextDueDate ? `Due ${formatDate(item.nextDueDate)}` : "No passing test yet"}
              </Text>
            </TouchableOpacity>
          );
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 16,
  },
  headerLeft: { flexDirection: "row", alignItems: "center", gap: 10 },
  headerLogo: { width: 34, height: 34 },
  addButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.blue600,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: { fontSize: 22, fontWeight: "700", color: colors.slate900 },
  headerSubtitle: { fontSize: 13, color: colors.slate500, marginTop: 2 },
  listContent: { paddingHorizontal: 16, paddingBottom: 24 },
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  cardTitle: { fontSize: 15, fontWeight: "600", color: colors.slate900, flex: 1 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  badgeText: { fontSize: 11, fontWeight: "600" },
  cardMetaRow: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 6 },
  cardMeta: { fontSize: 12, color: colors.slate500 },
  cardDue: { fontSize: 12, color: colors.slate400, marginTop: 4 },
  emptyText: { textAlign: "center", color: colors.slate400, marginTop: 60, fontSize: 14, paddingHorizontal: 20 },
});
