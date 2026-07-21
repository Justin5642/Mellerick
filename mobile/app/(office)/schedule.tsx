import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, SectionList, StyleSheet, RefreshControl } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { supabase } from "../../lib/supabase";
import { colors } from "../../lib/theme";
import { JobListRow } from "../../design/components/JobListRow";
import { businessDayLabel, formatBusinessTime } from "../../lib/date";

interface SchedJob {
  id: string;
  job_number: number;
  title: string;
  status: string;
  scheduled_start: string;
  scheduled_end: string | null;
  customers: { name: string } | null;
  profiles?: { full_name: string } | null;
}

export default function ScheduleScreen() {
  const router = useRouter();
  const [jobs, setJobs] = useState<SchedJob[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const { data } = await supabase
      .from("jobs")
      .select("*, customers(name), profiles!jobs_assigned_to_fkey(full_name)")
      .not("scheduled_start", "is", null)
      .not("status", "in", '("completed","cancelled")')
      .order("scheduled_start");
    setJobs((data as unknown as SchedJob[]) ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // Group the (already start-ordered) jobs into day sections.
  const sections = useMemo(() => {
    const map = new Map<string, SchedJob[]>();
    for (const j of jobs) {
      const key = businessDayLabel(j.scheduled_start);
      const arr = map.get(key);
      if (arr) arr.push(j);
      else map.set(key, [j]);
    }
    return Array.from(map, ([title, data]) => ({ title, data }));
  }, [jobs]);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Text style={styles.h1}>Schedule</Text>
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(j) => j.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.blue600} />}
        stickySectionHeadersEnabled={false}
        ListEmptyComponent={<Text style={styles.empty}>Nothing scheduled.</Text>}
        renderSectionHeader={({ section }) => <Text style={styles.dayHead}>{section.title}</Text>}
        renderItem={({ item }) => (
          <View style={styles.card}>
            <JobListRow
              jobNumber={item.job_number}
              title={item.title}
              subtitle={`${item.customers?.name ?? "—"}${item.profiles?.full_name ? ` · ${item.profiles.full_name}` : " · Unassigned"}`}
              status={item.status}
              leading={
                <View style={styles.timeCol}>
                  <Text style={styles.timeStart}>{formatBusinessTime(item.scheduled_start)}</Text>
                  {item.scheduled_end ? <Text style={styles.timeEnd}>{formatBusinessTime(item.scheduled_end)}</Text> : null}
                </View>
              }
              onPress={() => router.push(`/job/${item.id}`)}
            />
          </View>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6 },
  h1: { fontSize: 22, fontWeight: "800", color: colors.slate900 },
  dayHead: { fontSize: 13, fontWeight: "700", color: colors.slate500, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4, textTransform: "uppercase" },
  card: { backgroundColor: colors.card, marginHorizontal: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 12, overflow: "hidden", marginTop: 6 },
  empty: { textAlign: "center", color: colors.slate400, marginTop: 40, fontSize: 13 },
  timeCol: { width: 52, alignItems: "center" },
  timeStart: { fontSize: 12, fontWeight: "700", color: colors.blue600 },
  timeEnd: { fontSize: 11, color: colors.slate400 },
});
