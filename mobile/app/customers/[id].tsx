import { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, TouchableOpacity, Linking } from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { getCustomer, type CustomerDetail, type Site } from "../../lib/data/reads/customers";
import { CustomerFormSheet } from "../../components/customer/customer-form";
import { SiteFormSheet } from "../../components/customer/site-form";

export default function CustomerDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [customer, setCustomer] = useState<CustomerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [siteDraft, setSiteDraft] = useState<Site | "new" | null>(null);

  const load = useCallback(async () => {
    setCustomer(await getCustomer(id));
    setLoading(false);
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: "Customer" }} />
        <ActivityIndicator size="large" color={colors.blue600} />
      </View>
    );
  }
  if (!customer) {
    return (
      <View style={styles.center}>
        <Stack.Screen options={{ title: "Customer" }} />
        <Text style={styles.muted}>Customer not found.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Stack.Screen
        options={{
          title: customer.name,
          headerRight: () => (
            <TouchableOpacity onPress={() => setEditing(true)} accessibilityLabel="Edit customer">
              <Ionicons name="create-outline" size={22} color={colors.blue600} />
            </TouchableOpacity>
          ),
        }}
      />

      <View style={styles.header}>
        <Text style={styles.name}>{customer.name}</Text>
        {!!customer.company && <Text style={styles.company}>{customer.company}</Text>}
      </View>

      <Card title="Contact">
        {customer.email ? <Contact icon="mail-outline" value={customer.email} onPress={() => Linking.openURL(`mailto:${customer.email}`)} /> : null}
        {customer.phone ? <Contact icon="call-outline" value={customer.phone} onPress={() => Linking.openURL(`tel:${customer.phone}`)} /> : null}
        {customer.mobile ? <Contact icon="phone-portrait-outline" value={customer.mobile} onPress={() => Linking.openURL(`tel:${customer.mobile}`)} /> : null}
        {customer.abn ? <Row label="ABN" value={customer.abn} /> : null}
        {!customer.email && !customer.phone && !customer.mobile && !customer.abn ? <Text style={styles.muted}>No contact details.</Text> : null}
      </Card>

      <View style={styles.sitesHead}>
        <Text style={styles.sectionTitle}>Sites ({customer.sites.length})</Text>
        <TouchableOpacity onPress={() => setSiteDraft("new")} style={styles.addSite}>
          <Ionicons name="add" size={16} color={colors.blue600} />
          <Text style={styles.addSiteText}>Add site</Text>
        </TouchableOpacity>
      </View>
      {customer.sites.length === 0 ? (
        <Text style={styles.mutedPad}>No sites yet.</Text>
      ) : (
        customer.sites.map((s) => (
          <TouchableOpacity key={s.id} style={styles.siteCard} onPress={() => setSiteDraft(s)}>
            <View style={{ flex: 1 }}>
              <Text style={styles.siteName}>{s.name}</Text>
              <Text style={styles.siteAddr}>
                {[s.address_line1, s.address_line2, `${s.suburb} ${s.state} ${s.postcode}`].filter(Boolean).join(", ")}
              </Text>
            </View>
            <Ionicons name="create-outline" size={16} color={colors.slate400} />
          </TouchableOpacity>
        ))
      )}

      {!!customer.notes && (
        <Card title="Notes">
          <Text style={styles.body}>{customer.notes}</Text>
        </Card>
      )}

      <CustomerFormSheet visible={editing} existing={customer} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); load(); }} />
      {/* No onRemoved: sites can't be hard-deleted (jobs/quotes FK RESTRICT) and
          have no is_active column for a soft-delete — see Q17. Edit only. */}
      <SiteFormSheet
        visible={siteDraft !== null}
        customerId={customer.id}
        existing={siteDraft === "new" ? null : siteDraft}
        onClose={() => setSiteDraft(null)}
        onSaved={() => { setSiteDraft(null); load(); }}
      />
    </ScrollView>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      {children}
    </View>
  );
}
function Contact({ icon, value, onPress }: { icon: keyof typeof Ionicons.glyphMap; value: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.contact} onPress={onPress}>
      <Ionicons name={icon} size={16} color={colors.blue600} />
      <Text style={styles.contactText}>{value}</Text>
    </TouchableOpacity>
  );
}
function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.kv}>
      <Text style={styles.kvLabel}>{label}</Text>
      <Text style={styles.kvValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 16, gap: 14, paddingBottom: 40 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg },
  header: {},
  name: { fontSize: 20, fontWeight: "800", color: colors.slate900 },
  company: { fontSize: 14, color: colors.slate500, marginTop: 2 },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 14, gap: 8 },
  cardTitle: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginBottom: 2 },
  muted: { fontSize: 13, color: colors.slate500 },
  mutedPad: { fontSize: 13, color: colors.slate400, paddingHorizontal: 4 },
  body: { fontSize: 14, color: colors.slate700, lineHeight: 20 },
  contact: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 2 },
  contactText: { fontSize: 14, color: colors.blue600, fontWeight: "500" },
  kv: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
  kvLabel: { fontSize: 13, color: colors.slate500 },
  kvValue: { fontSize: 13, color: colors.slate900, fontWeight: "500" },
  sitesHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 4 },
  sectionTitle: { fontSize: 15, fontWeight: "700", color: colors.slate900 },
  addSite: { flexDirection: "row", alignItems: "center", gap: 4 },
  addSiteText: { fontSize: 13, color: colors.blue600, fontWeight: "600" },
  siteCard: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 14 },
  siteName: { fontSize: 14, fontWeight: "600", color: colors.slate900 },
  siteAddr: { fontSize: 12, color: colors.slate500, marginTop: 2 },
});
