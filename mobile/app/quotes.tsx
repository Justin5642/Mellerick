import { useCallback, useEffect, useState } from "react";
import { View, Text, FlatList, StyleSheet, RefreshControl, ActivityIndicator } from "react-native";
import { Stack, useRouter } from "expo-router";
import { supabase } from "../lib/supabase";
import { colors } from "../lib/theme";
import { formatQuoteNumber } from "../lib/finance";
import { FinanceListRow } from "../design/components/FinanceListRow";

interface Quote {
  id: string;
  quote_number: number | string;
  title: string;
  total: number | null;
  status: string;
  valid_until: string | null;
  customers: { name: string } | null;
}

const PAGE = 50;
const SELECT = "id, quote_number, title, total, status, valid_until, customers(name)";

export default function QuotesScreen() {
  const router = useRouter();
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const loadFirst = useCallback(async () => {
    const { data } = await supabase.from("quotes").select(SELECT).order("created_at", { ascending: false }).range(0, PAGE - 1);
    const rows = (data as unknown as Quote[]) ?? [];
    setQuotes(rows);
    setHasMore(rows.length === PAGE);
  }, []);

  useEffect(() => {
    loadFirst();
  }, [loadFirst]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadFirst();
    setRefreshing(false);
  }, [loadFirst]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    const { data } = await supabase.from("quotes").select(SELECT).order("created_at", { ascending: false }).range(quotes.length, quotes.length + PAGE - 1);
    const next = (data as unknown as Quote[]) ?? [];
    setQuotes((prev) => [...prev, ...next]);
    setHasMore(next.length === PAGE);
    setLoadingMore(false);
  }, [loadingMore, hasMore, quotes.length]);

  function subtitle(q: Quote): string {
    const parts = [q.customers?.name ?? "—"];
    if (q.valid_until) parts.push(`valid to ${new Date(q.valid_until).toLocaleDateString("en-AU")}`);
    return parts.join(" · ");
  }

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: "Quotes" }} />
      <FlatList
        data={quotes}
        keyExtractor={(q) => q.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.blue600} />}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={<Text style={styles.empty}>No quotes yet.</Text>}
        ListFooterComponent={loadingMore ? <ActivityIndicator style={{ paddingVertical: 16 }} color={colors.blue600} /> : null}
        renderItem={({ item }) => (
          <FinanceListRow
            number={formatQuoteNumber(item.quote_number)}
            title={item.title}
            subtitle={subtitle(item)}
            amount={item.total}
            statusDomain="quoteStatus"
            statusValue={item.status}
            onPress={() => router.push(`/quotes/${item.id}`)}
          />
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  empty: { textAlign: "center", color: colors.slate400, marginTop: 40, fontSize: 13 },
});
