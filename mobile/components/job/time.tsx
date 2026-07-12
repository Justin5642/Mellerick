import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, FlatList } from "react-native";
import { supabase } from "../../lib/supabase";
import { colors } from "../../lib/theme";

interface TimeEntry {
  id: string;
  staff_id: string;
  clock_in: string;
  clock_out: string | null;
  hours: number | null;
  auto_clocked: boolean;
  entry_type?: "work" | "travel";
  profiles: { full_name: string } | null;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" });
}
function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
}

export function JobTimeTab({ jobId, currentUserId }: { jobId: string; currentUserId: string }) {
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const loadEntries = useCallback(async () => {
    const { data } = await supabase
      .from("time_entries")
      .select("*, profiles(full_name)")
      .eq("job_id", jobId)
      .order("clock_in", { ascending: false });
    setEntries((data as any) ?? []);
  }, [jobId]);

  useEffect(() => {
    loadEntries();
  }, [loadEntries]);

  const myOpenEntry = entries.find((e) => e.staff_id === currentUserId && e.entry_type !== "travel" && !e.clock_out);
  const workEntries = entries.filter((e) => e.entry_type !== "travel");
  const travelEntries = entries.filter((e) => e.entry_type === "travel");
  const totalHours = workEntries.reduce((sum, e) => sum + (e.hours ? Number(e.hours) : 0), 0);
  const totalTravelHours = travelEntries.reduce((sum, e) => sum + (e.hours ? Number(e.hours) : 0), 0);

  async function clockIn() {
    if (myOpenEntry || loading) return;
    setLoading(true);
    await supabase.from("time_entries").insert({
      job_id: jobId,
      staff_id: currentUserId,
      clock_in: new Date().toISOString(),
      auto_clocked: false,
    });
    await loadEntries();
    setLoading(false);
  }

  async function clockOut() {
    if (!myOpenEntry || loading) return;
    setLoading(true);
    const clockOutTime = new Date().toISOString();
    const hours = Math.round(((new Date(clockOutTime).getTime() - new Date(myOpenEntry.clock_in).getTime()) / 3600000) * 100) / 100;
    await supabase.from("time_entries").update({ clock_out: clockOutTime, hours }).eq("id", myOpenEntry.id);
    await loadEntries();
    setLoading(false);
  }

  return (
    <View style={styles.container}>
      <View style={styles.clockRow}>
        {!myOpenEntry ? (
          <TouchableOpacity style={styles.clockInButton} onPress={clockIn} disabled={loading}>
            <Text style={styles.clockInText}>{loading ? "..." : "Clock In"}</Text>
          </TouchableOpacity>
        ) : (
          <>
            <TouchableOpacity style={styles.clockOutButton} onPress={clockOut} disabled={loading}>
              <Text style={styles.clockOutText}>{loading ? "..." : "Clock Out"}</Text>
            </TouchableOpacity>
            <Text style={styles.sinceText}>Since {formatTime(myOpenEntry.clock_in)}</Text>
          </>
        )}
      </View>

      {entries.length > 0 && (
        <View style={styles.logHeader}>
          <Text style={styles.logTitle}>Time Log</Text>
          <Text style={styles.logTotal}>
            {totalHours.toFixed(1)}h total
            {totalTravelHours > 0 ? `  ·  ${totalTravelHours.toFixed(1)}h travel` : ""}
          </Text>
        </View>
      )}

      <FlatList
        data={entries}
        keyExtractor={(e) => e.id}
        scrollEnabled={false}
        ListEmptyComponent={<Text style={styles.emptyText}>No time logged yet</Text>}
        renderItem={({ item }) => {
          const isTravel = item.entry_type === "travel";
          return (
            <View style={[styles.entryRow, isTravel && styles.entryRowTravel]}>
              <View>
                <Text style={styles.entryName}>
                  {item.profiles?.full_name ?? "—"}
                  {isTravel ? " (travel)" : item.auto_clocked ? " (auto)" : ""}
                </Text>
                <Text style={styles.entryDate}>{formatDate(item.clock_in)}</Text>
              </View>
              <Text style={styles.entryTime}>
                {formatTime(item.clock_in)} → {item.clock_out ? formatTime(item.clock_out) : "now"}
                {item.hours != null ? `  ${Number(item.hours).toFixed(1)}h` : ""}
              </Text>
            </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 16 },
  clockRow: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 16 },
  clockInButton: { backgroundColor: colors.blue600, borderRadius: 10, paddingHorizontal: 20, paddingVertical: 12 },
  clockInText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  clockOutButton: { backgroundColor: colors.red100, borderRadius: 10, paddingHorizontal: 20, paddingVertical: 12, borderWidth: 1, borderColor: colors.red600 },
  clockOutText: { color: colors.red600, fontWeight: "600", fontSize: 14 },
  sinceText: { color: colors.green600, fontWeight: "600", fontSize: 13 },
  logHeader: { flexDirection: "row", justifyContent: "space-between", marginBottom: 8 },
  logTitle: { fontSize: 13, fontWeight: "700", color: colors.slate700 },
  logTotal: { fontSize: 13, fontWeight: "700", color: colors.slate900 },
  entryRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 12,
    marginBottom: 8,
  },
  entryRowTravel: {
    backgroundColor: colors.blue100,
    borderColor: colors.blue100,
  },
  entryName: { fontSize: 13, fontWeight: "600", color: colors.slate700 },
  entryDate: { fontSize: 11, color: colors.slate400, marginTop: 2 },
  entryTime: { fontSize: 12, color: colors.slate500 },
  emptyText: { textAlign: "center", color: colors.slate400, marginTop: 20, fontSize: 13 },
});
