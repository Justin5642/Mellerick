import { useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../lib/supabase";
import { colors } from "../../lib/theme";

// Surfaces the note a scheduler (office, on web or mobile) typed into the
// "Schedule job" flow at the very top of the Overview tab — the first thing a
// technician sees on opening the job — instead of it sitting unlabeled, one
// of many entries, on the 6th-of-7 Notes tab. Read-only here; the full history
// (including every other schedule note, if the job was rescheduled more than
// once) still lives in Notes & Activity, tagged "Scheduling note" there too.
//
// Best-effort, same reasoning as the calendar resync in overview.tsx: this is
// supplementary context, not safety-critical, so a failed fetch just means no
// banner rather than taking down a screen that otherwise loaded fine.
interface ScheduleNote {
  content: string;
  created_at: string;
  profiles: { full_name: string } | null;
}

export function ScheduleNoteBanner({ jobId }: { jobId: string }) {
  const [note, setNote] = useState<ScheduleNote | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const { data } = await supabase
          .from("job_notes")
          .select("content, created_at, profiles(full_name)")
          .eq("job_id", jobId)
          .eq("source", "schedule")
          .order("created_at", { ascending: false })
          .limit(1);
        if (!cancelled) setNote((data?.[0] as unknown as ScheduleNote) ?? null);
      } catch {
        // Best-effort — see file comment.
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  if (!note) return null;

  return (
    <View style={styles.banner}>
      <View style={styles.header}>
        <Ionicons name="calendar" size={14} color={colors.blue600} />
        <Text style={styles.headerText}>Scheduling note</Text>
      </View>
      <Text style={styles.content}>{note.content}</Text>
      <Text style={styles.meta}>
        {note.profiles?.full_name ?? "Office"} ·{" "}
        {new Date(note.created_at).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { backgroundColor: colors.blue100, borderRadius: 10, padding: 12, marginBottom: 12, gap: 4 },
  header: { flexDirection: "row", alignItems: "center", gap: 6 },
  headerText: { fontSize: 12, fontWeight: "700", color: colors.blue600, textTransform: "uppercase" },
  content: { fontSize: 14, color: colors.slate900 },
  meta: { fontSize: 11, color: colors.slate400 },
});
