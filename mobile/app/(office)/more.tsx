import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useRouter, type Href } from "expo-router";
import { colors } from "../../lib/theme";
import { useAuth } from "../../lib/auth-context";
import { useIsAdmin } from "../../design/guards/useRole";

interface Item {
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  href: Href;
}

const OPERATIONS: Item[] = [
  { label: "Customers", icon: "people-outline", href: "/customers" },
  { label: "Inventory", icon: "cube-outline", href: "/inventory" },
  { label: "Fleet & Equipment", icon: "car-outline", href: "/fleet" },
];
const FINANCIAL: Item[] = [
  { label: "Quotes", icon: "document-text-outline", href: "/quotes" },
  { label: "Invoices", icon: "receipt-outline", href: "/invoices" },
  { label: "Pricing", icon: "pricetag-outline", href: "/pricing" },
  { label: "Reports", icon: "bar-chart-outline", href: "/reports" },
];
const ADMIN: Item[] = [
  { label: "Staff", icon: "id-card-outline", href: "/staff" },
  { label: "Settings", icon: "settings-outline", href: "/settings" },
];

export default function MoreScreen() {
  const router = useRouter();
  const { profile, signOut } = useAuth();
  const isAdmin = useIsAdmin();

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.h1}>More</Text>

        <Group title="Operations" items={OPERATIONS} onPress={(h) => router.push(h)} />
        <Group title="Financial" items={FINANCIAL} onPress={(h) => router.push(h)} />
        {isAdmin && <Group title="Admin" items={ADMIN} onPress={(h) => router.push(h)} />}

        <View style={styles.group}>
          <Text style={styles.groupTitle}>Account</Text>
          <View style={styles.card}>
            <View style={styles.accountRow}>
              <Text style={styles.accountName}>{profile?.full_name ?? "—"}</Text>
              <Text style={styles.accountRole}>{profile?.role ?? ""}</Text>
            </View>
            <TouchableOpacity style={styles.row} onPress={signOut}>
              <Ionicons name="log-out-outline" size={20} color={colors.red600} />
              <Text style={[styles.rowLabel, { color: colors.red600 }]}>Sign out</Text>
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Group({ title, items, onPress }: { title: string; items: Item[]; onPress: (href: Href) => void }) {
  return (
    <View style={styles.group}>
      <Text style={styles.groupTitle}>{title}</Text>
      <View style={styles.card}>
        {items.map((it, i) => (
          <TouchableOpacity key={it.label} style={[styles.row, i > 0 && styles.rowBorder]} onPress={() => onPress(it.href)}>
            <Ionicons name={it.icon} size={20} color={colors.slate700} />
            <Text style={styles.rowLabel}>{it.label}</Text>
            <Ionicons name="chevron-forward" size={16} color={colors.slate400} />
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, paddingBottom: 40, gap: 18 },
  h1: { fontSize: 22, fontWeight: "800", color: colors.slate900, marginTop: 4 },
  group: { gap: 8 },
  groupTitle: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginLeft: 4 },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 12, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 14 },
  rowBorder: { borderTopWidth: 1, borderTopColor: colors.border },
  rowLabel: { flex: 1, fontSize: 15, fontWeight: "500", color: colors.slate900 },
  accountRow: { paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  accountName: { fontSize: 15, fontWeight: "700", color: colors.slate900 },
  accountRole: { fontSize: 12, color: colors.slate500, marginTop: 2, textTransform: "capitalize" },
});
