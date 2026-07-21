import { useCallback, useEffect, useState } from "react";
import { View, Text, FlatList, StyleSheet, RefreshControl, ActivityIndicator, TouchableOpacity } from "react-native";
import { Stack, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../lib/supabase";
import { colors } from "../lib/theme";
import { formatInvoiceNumber } from "../lib/finance";
import { FinanceListRow } from "../design/components/FinanceListRow";
import { MoneyText } from "../design/components/MoneyText";

interface Invoice {
  id: string;
  invoice_number: number | string;
  title: string;
  total: number | null;
  status: string;
  due_date: string | null;
  customers: { name: string } | null;
}
interface ReadyJob {
  id: string;
  job_number: number;
  title: string;
  customers: { name: string } | null;
}
interface ReadyVariation {
  id: string;
  total_amount: number | null;
  jobs: { id: string; job_number: number; title: string; customers: { name: string } | null } | null;
}

const PAGE = 50;
const SELECT = "id, invoice_number, title, total, status, due_date, customers(name)";

export default function InvoicesScreen() {
  const router = useRouter();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [readyJobs, setReadyJobs] = useState<ReadyJob[]>([]);
  const [readyVars, setReadyVars] = useState<ReadyVariation[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const loadFirst = useCallback(async () => {
    const [invRes, jobsRes, varsRes] = await Promise.all([
      // id tiebreaker => stable pagination over the non-unique created_at.
      supabase.from("invoices").select(SELECT).order("created_at", { ascending: false }).order("id", { ascending: false }).range(0, PAGE - 1),
      // "Ready to invoice" queue (mirrors the web invoices page's 2 extra
      // sources) so unbilled work still surfaces on mobile.
      supabase.from("jobs").select("id, job_number, title, customers(name)").eq("ready_to_invoice", true).order("updated_at", { ascending: false }),
      supabase.from("job_variations").select("id, total_amount, jobs(id, job_number, title, customers(name))").in("status", ["approved", "auto_approved"]).is("invoice_id", null),
    ]);
    const rows = (invRes.data as unknown as Invoice[]) ?? [];
    setInvoices(rows);
    setHasMore(rows.length === PAGE);
    setReadyJobs((jobsRes.data as unknown as ReadyJob[]) ?? []);
    setReadyVars((varsRes.data as unknown as ReadyVariation[]) ?? []);
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
    const { data } = await supabase
      .from("invoices")
      .select(SELECT)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(invoices.length, invoices.length + PAGE - 1);
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

  const readyCount = readyJobs.length + readyVars.length;
  const ListHeader = readyCount === 0 ? null : (
    <View style={styles.readyCard}>
      <View style={styles.readyHead}>
        <Ionicons name="cash-outline" size={16} color={colors.orange700} />
        <Text style={styles.readyTitle}>Ready to Invoice ({readyCount})</Text>
      </View>
      {readyJobs.map((j) => (
        <TouchableOpacity key={`job-${j.id}`} style={styles.readyRow} onPress={() => router.push(`/job/${j.id}`)}>
          <Text style={styles.readyRowText} numberOfLines={1}>#{j.job_number} — {j.title}</Text>
          <Text style={styles.readyRowSub} numberOfLines={1}>{j.customers?.name ?? "—"}</Text>
        </TouchableOpacity>
      ))}
      {readyVars.map((v) => (
        <TouchableOpacity key={`var-${v.id}`} style={styles.readyRow} onPress={() => v.jobs?.id && router.push(`/job/${v.jobs.id}`)} disabled={!v.jobs?.id}>
          <View style={styles.readyVarRow}>
            <Text style={styles.readyRowText} numberOfLines={1}>
              {v.jobs ? `#${v.jobs.job_number} — ${v.jobs.title}` : "Variation"} (variation)
            </Text>
            <MoneyText amount={v.total_amount} style={styles.readyAmount} />
          </View>
          <Text style={styles.readyRowSub} numberOfLines={1}>{v.jobs?.customers?.name ?? "—"}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: "Invoices" }} />
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
