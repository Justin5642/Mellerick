import { useCallback, useState } from "react";
import { View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl, ActivityIndicator } from "react-native";
import { Stack, useFocusEffect, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { listBackflowDevices, type BackflowRow } from "../../lib/data/reads/backflow";
import { ScreenError } from "../../design/components/ScreenError";
import { BackflowDeviceRow } from "../../components/backflow/device-row";

// Office/admin-reachable backflow list (from the More hub + the Dashboard KPI).
// Distinct route from the technician tab's /backflow, but renders the SAME read
// and row component so the two never diverge (Q12).
export default function BackflowListScreen() {
  const router = useRouter();
  const [rows, setRows] = useState<BackflowRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    // listBackflowDevices now THROWS on a failed query instead of returning [].
    // Without this catch the throw would skip both flag resets and leave a
    // spinner forever; without the finally, a retry could never clear it either.
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
      load();
    }, [load])
  );

  function onRefresh() {
    setRefreshing(true);
    load();
  }

  const overdueCount = rows.filter((r) => r.status === "overdue").length;
  const dueSoonCount = rows.filter((r) => r.status === "due_soon").length;

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: "Backflow" }} />
        <ActivityIndicator size="large" color={colors.blue600} />
      </View>
    );
  }

  // Checked BEFORE the list renders, so a failed load can never fall through to
  // "No backflow devices registered yet." — a device list that silently reads as
  // empty is how an overdue test gets missed.
  if (error) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: "Backflow" }} />
        <ScreenError
          error={error}
          onRetry={() => {
            setLoading(true);
            load();
          }}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: "Backflow",
          headerRight: () => (
            <TouchableOpacity onPress={() => router.push("/backflow/new")} accessibilityLabel="Register device" hitSlop={8}>
              <Ionicons name="add" size={26} color={colors.blue600} />
            </TouchableOpacity>
          ),
        }}
      />
      <Text style={styles.summary}>
        {rows.length} device{rows.length !== 1 ? "s" : ""}
        {overdueCount > 0 ? ` · ${overdueCount} overdue` : ""}
        {dueSoonCount > 0 ? ` · ${dueSoonCount} due soon` : ""}
      </Text>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.device.id}
        contentContainerStyle={styles.listContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.blue600} />}
        ListEmptyComponent={<Text style={styles.emptyText}>No backflow devices registered yet.</Text>}
        renderItem={({ item }) => <BackflowDeviceRow row={item} onPress={() => router.push(`/backflow/${item.device.id}`)} />}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  summary: { fontSize: 13, color: colors.slate500, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  listContent: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24 },
  emptyText: { textAlign: "center", color: colors.slate400, marginTop: 60, fontSize: 14, paddingHorizontal: 20 },
});
