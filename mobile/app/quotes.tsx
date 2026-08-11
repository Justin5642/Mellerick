import { useCallback, useEffect, useState } from "react";
import { View, Text, FlatList, StyleSheet, RefreshControl, ActivityIndicator, TouchableOpacity } from "react-native";
import { Stack, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../lib/theme";
import { formatQuoteNumber } from "../lib/finance";
import { FinanceListRow } from "../design/components/FinanceListRow";
import { ScreenError } from "../design/components/ScreenError";
import { listQuotes, type QuoteListRow as Quote } from "../lib/data/reads/finance";

const PAGE = 50;

export default function QuotesScreen() {
  const router = useRouter();
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<unknown>(null);

  // listQuotes now THROWS on a failed query instead of returning []. Uncaught,
  // the rejection skips setRefreshing(false) and leaves the pull-to-refresh
  // spinner up forever, and the list underneath still reads "No quotes yet." —
  // a broken query presented as a business that has never written a quote.
  const loadFirst = useCallback(async () => {
    try {
      setError(null);
      const rows = await listQuotes(0, PAGE);
      setQuotes(rows);
      setHasMore(rows.length === PAGE);
    } catch (e) {
      setError(e);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadFirst();
  }, [loadFirst]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    // A failed page is surfaced rather than quietly ending the list: stopping
    // at page 1 without saying so tells the reader they have seen every quote.
    try {
      const next = await listQuotes(quotes.length, PAGE);
      setQuotes((prev) => [...prev, ...next]);
      setHasMore(next.length === PAGE);
    } catch (e) {
      setError(e);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, quotes.length]);

  function subtitle(q: Quote): string {
    const parts = [q.customers?.name ?? "—"];
    if (q.valid_until) parts.push(`valid to ${new Date(q.valid_until).toLocaleDateString("en-AU")}`);
    return parts.join(" · ");
  }

  // Checked BEFORE the list renders, so a failed load can never fall through to
  // the "No quotes yet." empty state. That confusion is the entire bug.
  if (error) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: "Quotes" }} />
        <ScreenError
          error={error}
          onRetry={() => {
            void loadFirst();
          }}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: "Quotes",
          headerRight: () => (
            <TouchableOpacity onPress={() => router.push("/quotes/new")} accessibilityLabel="New quote">
              <Ionicons name="add" size={26} color={colors.blue600} />
            </TouchableOpacity>
          ),
        }}
      />
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
