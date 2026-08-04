import { useCallback, useEffect, useState } from "react";
import { View, Text, FlatList, StyleSheet, RefreshControl, ActivityIndicator, TouchableOpacity } from "react-native";
import { Stack, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../lib/theme";
import { formatInvoiceNumber } from "../lib/finance";
import { FinanceListRow } from "../design/components/FinanceListRow";
import { MoneyText } from "../design/components/MoneyText";
import { ScreenError } from "../design/components/ScreenError";
import { listInvoices, listReadyToInvoice, type InvoiceListRow as Invoice, type ReadyJob, type ReadyVariation } from "../lib/data/reads/finance";

const PAGE = 50;

export default function InvoicesScreen() {
  const router = useRouter();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [readyJobs, setReadyJobs] = useState<ReadyJob[]>([]);
  const [readyVars, setReadyVars] = useState<ReadyVariation[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const loadFirst = useCallback(async () => {
    // listInvoices / listReadyToInvoice now THROW on a failed query instead of
    // returning []. Uncaught, the throw would skip setRefreshing(false) and pin
    // the pull-to-refresh spinner up forever; uncaught on first load it would
    // leave the list at [], which reads as "No invoices yet." on a query that
    // never actually ran.
    try {
      setError(null);
      const [rows, ready] = await Promise.all([listInvoices(0, PAGE), listReadyToInvoice()]);
      setInvoices(rows);
      setHasMore(rows.length === PAGE);
      setReadyJobs(ready.jobs);
      setReadyVars(ready.variations);
    } catch (e) {
      setError(e);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadFirst();
  }, [loadFirst]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadFirst();
  }, [loadFirst]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const next = await listInvoices(invoices.length, PAGE);
      setInvoices((prev) => [...prev, ...next]);
      setHasMore(next.length === PAGE);
    } catch (e) {
      // A page that failed to load is not the end of the list. Swallowing this
      // would leave a partial list looking complete — the same lie in a smaller
      // package, and on invoices it is money that goes missing from the view.
      setError(e);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, invoices.length]);

  function subtitle(inv: Invoice): string {
    const parts = [inv.customers?.name ?? "—"];
    if (inv.due_date) parts.push(`due ${new Date(inv.due_date).toLocaleDateString("en-AU")}`);
    return parts.join(" · ");
  }

  const readyCount = readyJobs.length + readyVars.length;
  const ListHeader = readyCount === 0 ? null : (
    <View style={styles.readyCard}>
      <View style={styles.readyHead}>
        <Ionicons name="cash-outline" size={16} color={colors.orange700} />
        <Text style={styles.readyTitle}>Ready to Invoice ({readyCount})</Text>
      </View>
      {readyJobs.map((j) => (
        <TouchableOpacity key={`job-${j.id}`} style={styles.readyRow} onPress={() => router.push(`/invoices/new?jobId=${j.id}`)}>
          <View style={styles.readyVarRow}>
            <Text style={styles.readyRowText} numberOfLines={1}>#{j.job_number} — {j.title}</Text>
            <Ionicons name="chevron-forward" size={14} color={colors.orange700} />
          </View>
          <Text style={styles.readyRowSub} numberOfLines={1}>{j.customers?.name ?? "—"} · tap to invoice</Text>
        </TouchableOpacity>
      ))}
      {readyVars.map((v) => (
        <TouchableOpacity key={`var-${v.id}`} style={styles.readyRow} onPress={() => v.jobs?.id && router.push(`/invoices/new?jobId=${v.jobs.id}`)} disabled={!v.jobs?.id}>
          <View style={styles.readyVarRow}>
            <Text style={styles.readyRowText} numberOfLines={1}>
              {v.jobs ? `#${v.jobs.job_number} — ${v.jobs.title}` : "Variation"} (variation)
            </Text>
            <MoneyText amount={v.total_amount} style={styles.readyAmount} />
          </View>
          <Text style={styles.readyRowSub} numberOfLines={1}>{v.jobs?.customers?.name ?? "—"} · tap to invoice</Text>
        </TouchableOpacity>
      ))}
    </View>
  );

  // Checked BEFORE the list renders, so a failed load can never fall through to
  // "No invoices yet." — that confusion is the entire bug.
  if (error) {
    return (
      <View style={styles.container}>
        <Stack.Screen options={{ title: "Invoices" }} />
        <ScreenError
          error={error}
          onRetry={() => {
            // This screen's only busy flag is `refreshing`, so the retry reuses
            // it: the spinner it already has, rather than a blank list.
            setRefreshing(true);
            loadFirst();
          }}
        />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Stack.Screen
        options={{
          title: "Invoices",
          headerRight: () => (
            <TouchableOpacity onPress={() => router.push("/invoices/new")} accessibilityLabel="New invoice">
              <Ionicons name="add" size={26} color={colors.blue600} />
            </TouchableOpacity>
          ),
        }}
      />
      <FlatList
        data={invoices}
        keyExtractor={(i) => i.id}
        ListHeaderComponent={ListHeader}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.blue600} />}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={readyCount === 0 ? <Text style={styles.empty}>No invoices yet.</Text> : null}
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
  readyCard: { backgroundColor: colors.orange100, margin: 12, borderRadius: 12, padding: 12, gap: 4 },
  readyHead: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 4 },
  readyTitle: { fontSize: 13, fontWeight: "700", color: colors.orange700 },
  readyRow: { paddingVertical: 8, borderTopWidth: 1, borderTopColor: "rgba(194,65,12,0.15)" },
  readyVarRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  readyRowText: { fontSize: 13, fontWeight: "600", color: colors.slate900, flexShrink: 1 },
  readyRowSub: { fontSize: 12, color: colors.slate500, marginTop: 1 },
  readyAmount: { fontSize: 13, fontWeight: "700", color: colors.slate900 },
});
