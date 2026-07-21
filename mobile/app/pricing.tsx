import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, SectionList, StyleSheet, RefreshControl } from "react-native";
import { Stack } from "expo-router";
import { supabase } from "../lib/supabase";
import { colors } from "../lib/theme";
import { MoneyText } from "../design/components/MoneyText";

interface PricingItem {
  id: string;
  name: string;
  description: string | null;
  category: string;
  pricing_type: string;
  unit_price: number;
  unit: string | null;
}

function humanize(v: string): string {
  return v.replace(/_/g, " ");
}

export default function PricingScreen() {
  const [items, setItems] = useState<PricingItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("pricing_items")
      .select("id, name, description, category, pricing_type, unit_price, unit")
      .eq("is_active", true)
      .order("category")
      .order("name");
    setItems((data as unknown as PricingItem[]) ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const sections = useMemo(() => {
    const map = new Map<string, PricingItem[]>();
    for (const it of items) {
      const arr = map.get(it.category);
      if (arr) arr.push(it);
      else map.set(it.category, [it]);
    }
    return Array.from(map, ([title, data]) => ({ title, data }));
  }, [items]);

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: "Pricing" }} />
      <SectionList
        sections={sections}
        keyExtractor={(i) => i.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.blue600} />}
        stickySectionHeadersEnabled={false}
        ListEmptyComponent={<Text style={styles.empty}>No pricing items.</Text>}
        renderSectionHeader={({ section }) => <Text style={styles.catHead}>{humanize(section.title)}</Text>}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={styles.body}>
              <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
              <Text style={styles.meta} numberOfLines={1}>
                {humanize(item.pricing_type)}
                {item.description ? ` · ${item.description}` : ""}
              </Text>
            </View>
            <View style={styles.priceCol}>
              <MoneyText amount={item.unit_price} style={styles.price} />
              <Text style={styles.unit}>/ {item.unit ?? "each"}</Text>
            </View>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  catHead: { fontSize: 13, fontWeight: "700", color: colors.slate500, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4, textTransform: "capitalize" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: colors.card, borderTopWidth: 1, borderTopColor: colors.border },
  body: { flex: 1, minWidth: 0 },
  name: { fontSize: 14, fontWeight: "600", color: colors.slate900 },
  meta: { fontSize: 12, color: colors.slate500, marginTop: 2, textTransform: "capitalize" },
  priceCol: { alignItems: "flex-end" },
  price: { fontSize: 14, fontWeight: "700", color: colors.slate900 },
  unit: { fontSize: 11, color: colors.slate400 },
  empty: { textAlign: "center", color: colors.slate400, marginTop: 40, fontSize: 13 },
});
