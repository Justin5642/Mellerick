import { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, RefreshControl } from "react-native";
import { Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../lib/supabase";
import { colors } from "../lib/theme";

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

export default function SettingsScreen() {
  const [state, setState] = useState<Integrations | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await readIntegrations());
    } catch {
      setState({ xero: null, google: false });
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  const onRefresh = useCallback(async () => { setRefreshing(true); await load(); setRefreshing(false); }, [load]);

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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 40 },
  section: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginBottom: 8, marginLeft: 4 },
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
});
