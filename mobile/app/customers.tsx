import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, FlatList, StyleSheet, RefreshControl, TextInput, ActivityIndicator, TouchableOpacity, Alert } from "react-native";
import { Stack, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../lib/theme";
import { listCustomers, type CustomerListRow } from "../lib/data/reads/customers";
import { useCustomers } from "../lib/data/hooks/useCustomers";
import { CustomerFormSheet } from "../components/customer/customer-form";
import { ScreenError } from "../design/components/ScreenError";

const PAGE = 50;

export default function CustomersScreen() {
  const router = useRouter();
  const writes = useCustomers();
  const [customers, setCustomers] = useState<CustomerListRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const reqId = useRef(0);

  // listCustomers THROWS on a failed query rather than returning [], and this
  // screen had nowhere to put that: uncaught, the rejection skipped every setter
  // below and left the last-known list (or "No customers found.") on screen, so
  // a broken read and an empty address book looked identical.
  //
  // The error is cleared on success rather than on entry so a retry keeps the
  // failure on screen until the new read actually lands — clearing first would
  // flash the empty state in the gap.
  const search = useCallback(async (q: string) => {
    const id = ++reqId.current;
    try {
      const rows = await listCustomers(0, PAGE, q);
      if (id !== reqId.current) return;
      setCustomers(rows);
      setHasMore(!q.trim() && rows.length === PAGE);
      setError(null);
    } catch (e) {
      if (id !== reqId.current) return; // a superseded query's failure isn't the screen's state
      setError(e);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => search(query), 250);
    return () => clearTimeout(t);
  }, [query, search]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await search(query);
    setRefreshing(false);
  }, [query, search]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore || query.trim()) return;
    setLoadingMore(true);
    try {
      const next = await listCustomers(customers.length, PAGE);
      setCustomers((prev) => [...prev, ...next]);
      setHasMore(next.length === PAGE);
    } catch (e) {
      setError(e);
    } finally {
      // Without this, a thrown page leaves loadingMore stuck true — a permanent
      // footer spinner, and the guard above then blocks every later page.
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, query, customers.length]);

  // Toggle favourite: optimistically flip + re-pin (favourites first, then name),
  // then persist through the outbox. Revert (and re-sort) the row on write failure.
  const toggleFavorite = useCallback(
    async (row: CustomerListRow) => {
      if (!writes.ready) return;
      const next = !row.is_favorite;
      // Favourites-first, then name — mirrors the server ordering in listCustomers.
      const resortWith = (list: CustomerListRow[], fav: boolean) =>
        list
          .map((c) => (c.id === row.id ? { ...c, is_favorite: fav } : c))
          .sort((a, b) => Number(b.is_favorite) - Number(a.is_favorite) || a.name.localeCompare(b.name));
      // Invalidate any in-flight/debounced search so a late server response can't
      // land after this optimistic toggle and visibly un-flip the star before the
      // write has synced (search() bails when its id != reqId.current).
      reqId.current++;
      setCustomers((prev) => resortWith(prev, next));
      try {
        await writes.setFavorite(row.id, next);
      } catch {
        setCustomers((prev) => resortWith(prev, row.is_favorite)); // revert + re-sort
        Alert.alert("Couldn't update favourite", "Please try again.");
      }
    },
    [writes]
  );

  // Checked BEFORE the list renders, so a failed read can never fall through to
  // the "No customers found." empty state — the reads are served from the local
  // DB, so a failure here is a real fault and not just being off the network.
  if (error) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: "Customers" }} />
        <ScreenError
          error={error}
          onRetry={() => {
            void search(query);
          }}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: "Customers",
          headerRight: () => (
            <TouchableOpacity onPress={() => setCreating(true)} accessibilityLabel="Add customer">
              <Ionicons name="add" size={26} color={colors.blue600} />
            </TouchableOpacity>
          ),
        }}
      />
      <View style={styles.searchWrap}>
        <View style={styles.search}>
          <Ionicons name="search" size={16} color={colors.slate400} />
          <TextInput style={styles.searchInput} value={query} onChangeText={setQuery} placeholder="Search name or company" placeholderTextColor={colors.slate400} autoCorrect={false} />
        </View>
      </View>
      <FlatList
        data={customers}
        keyExtractor={(c) => c.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.blue600} />}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={<Text style={styles.empty}>No customers found.</Text>}
        ListFooterComponent={loadingMore ? <ActivityIndicator style={{ paddingVertical: 16 }} color={colors.blue600} /> : null}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.row} onPress={() => router.push(`/customers/${item.id}`)}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{item.name.charAt(0).toUpperCase()}</Text>
            </View>
            <View style={styles.body}>
              <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
              <Text style={styles.meta} numberOfLines={1}>
                {[item.company, item.phone || item.email].filter(Boolean).join(" · ") || "—"}
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => toggleFavorite(item)}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              accessibilityLabel={item.is_favorite ? "Remove from favourites" : "Add to favourites"}
              style={styles.star}
            >
              <Ionicons
                name={item.is_favorite ? "star" : "star-outline"}
                size={20}
                color={item.is_favorite ? colors.orange700 : colors.slate400}
              />
            </TouchableOpacity>
            <Ionicons name="chevron-forward" size={16} color={colors.slate400} />
          </TouchableOpacity>
        )}
      />

      <CustomerFormSheet
        visible={creating}
        onClose={() => setCreating(false)}
        onSaved={(id, synced) => {
          setCreating(false);
          if (synced) {
            router.push(`/customers/${id}`);
          } else {
            // Offline: the detail read can't see the queued row yet (D10). Confirm
            // + refresh the list rather than land on a "not found" screen.
            Alert.alert("Saved offline", "The customer is queued and will appear once you're back online.");
            void search(query);
          }
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  searchWrap: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6 },
  search: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8 },
  searchInput: { flex: 1, fontSize: 14, color: colors.slate900, padding: 0 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: colors.card, borderTopWidth: 1, borderTopColor: colors.border },
  avatar: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.blue100, alignItems: "center", justifyContent: "center" },
  avatarText: { fontSize: 15, fontWeight: "700", color: colors.blue600 },
  body: { flex: 1, minWidth: 0 },
  name: { fontSize: 14, fontWeight: "600", color: colors.slate900 },
  meta: { fontSize: 12, color: colors.slate500, marginTop: 2 },
  star: { padding: 2 },
  empty: { textAlign: "center", color: colors.slate400, marginTop: 40, fontSize: 13 },
});
