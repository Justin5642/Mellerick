import { useCallback, useEffect, useState } from "react";
import { View, Text, FlatList, StyleSheet, RefreshControl, ActivityIndicator } from "react-native";
import { Stack, useRouter } from "expo-router";
import { supabase } from "../lib/supabase";
import { colors } from "../lib/theme";
import { formatInvoiceNumber } from "../lib/finance";
import { FinanceListRow } from "../design/components/FinanceListRow";

interface Invoice {
  id: string;
  invoice_number: number | string;
  title: string;
  total: number | null;
  status: string;
  due_date: string | null;
  customers: { name: string } | null;
}

const PAGE = 50;
const SELECT = "id, invoice_number, title, total, status, due_date, customers(name)";

export default function InvoicesScreen() {
  const router = useRouter();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const loadFirst = useCallback(async () => {
    const { data } = await supabase.from("invoices").select(SELECT).order("created_at", { ascending: false }).range(0, PAGE - 1);
    const rows = (data as unknown as Invoice[]) ?? [];
    setInvoices(rows);
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
    const { data } = await supabase.from("invoices").select(SELECT).order("created_at", { ascending: false }).range(invoices.length, invoices.length + PAGE - 1);
    const next = (data as unknown as Invoice[]) ?? [];
    setInvoices((prev) => [...prev, ...next]);
    setHasMore(next.length === PAGE);
    setLoadingMore(false);
  }, [loadingMore, hasMore, invoices.length]);

  function subtitle(inv: Invoice): string {
    const parts = [inv.customers?.name ?? "—"];
    if (inv.due_date) parts.push(`due ${new Date(inv.due_date).toLocaleDateString("en-AU")}`);
    return parts.join(" · ");
  }

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: "Invoices" }} />
      <FlatList
        data={invoices}
        keyExtractor={(i) => i.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.blue600} />}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={<Text style={styles.empty}>No invoices yet.</Text>}
        ListFooterComponent={loadingMore ? <ActivityIndicator style={{ paddingVertical: 16 }} color={colors.blue600} /> : null}
        renderItem={({ item }) => (
          <FinanceListRow
            number={formatInvoiceNumber(item.invoice_number)}
            title={item.title}
            subtitle={subtitle(item)}
            amount={item.total}
            statusDomain="invoiceStatus"
            statusValue={item.status}
            onPress={() => router.push(`/invoices/${item.id}`)}
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
