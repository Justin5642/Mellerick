import { useCallback, useState } from "react";
import { View, Text, Image, StyleSheet, FlatList, TouchableOpacity, RefreshControl, ActivityIndicator } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { listBackflowDevices, type BackflowRow } from "../../lib/data/reads/backflow";
import { ScreenError } from "../../design/components/ScreenError";
import { BackflowDeviceRow } from "../../components/backflow/device-row";

export default function BackflowScreen() {
  const router = useRouter();
  const [rows, setRows] = useState<BackflowRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    // listBackflowDevices now THROWS on a failed query instead of returning [].
    // Without this catch the throw skips both flag resets below and leaves a
    // permanent spinner; without the finally, a pull-to-refresh failure would
    // also leave the refresh control spinning forever.
    try {
      setError(null);
      setRows(await listBackflowDevices());
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  function onRefresh() {
    setRefreshing(true);
    void load();
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

  // Checked BEFORE the list renders, so a failed load can never fall through to
  // "No backflow devices registered yet." — a device nobody knows is overdue is
  // exactly what this screen exists to prevent.
  if (error) {
    return (
      <SafeAreaView style={styles.container}>
        <ScreenError
          error={error}
          onRetry={() => {
            setLoading(true);
            void load();
          }}
        />
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
        renderItem={({ item }) => <BackflowDeviceRow row={item} onPress={() => router.push(`/backflow/${item.device.id}`)} />}
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
  emptyText: { textAlign: "center", color: colors.slate400, marginTop: 60, fontSize: 14, paddingHorizontal: 20 },
});
