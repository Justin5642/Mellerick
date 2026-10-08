import { useEffect, useState } from "react";
import { View, Text, StyleSheet, Modal, TouchableOpacity } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
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
//
// The first time a given note is shown on this device it ALSO pops up as a
// modal, so a technician opening the job from My Jobs can't miss it. Seen-ness
// is keyed by job + the note's created_at, so a new note (job rescheduled)
// pops up again, while reopening the job or switching tabs doesn't.
const SEEN_KEY_PREFIX = "scheduleNoteSeen:";

export function seenKey(jobId: string): string {
  return `${SEEN_KEY_PREFIX}${jobId}`;
}

/** True when this note hasn't been acknowledged on this device yet. */
export async function shouldPopUp(jobId: string, noteCreatedAt: string): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(seenKey(jobId))) !== noteCreatedAt;
  } catch {
    return false; // storage unavailable: the banner still shows; don't nag
  }
}

export async function markSeen(jobId: string, noteCreatedAt: string): Promise<void> {
  try {
    await AsyncStorage.setItem(seenKey(jobId), noteCreatedAt);
  } catch {
    // Best-effort: worst case it pops up once more next time.
  }
}

interface ScheduleNote {
  content: string;
  created_at: string;
  profiles: { full_name: string } | null;
}

export function ScheduleNoteBanner({ jobId }: { jobId: string }) {
  const [note, setNote] = useState<ScheduleNote | null>(null);
  const [popUp, setPopUp] = useState(false);

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
        const latest = (data?.[0] as unknown as ScheduleNote) ?? null;
        if (cancelled) return;
        setNote(latest);
        if (latest && (await shouldPopUp(jobId, latest.created_at)) && !cancelled) setPopUp(true);
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

  function dismiss() {
    setPopUp(false);
    if (note) void markSeen(jobId, note.created_at);
  }

  const author = note.profiles?.full_name ?? "Office";
  const when = new Date(note.created_at).toLocaleDateString("en-AU", { day: "numeric", month: "short" });

  return (
    <>
    <Modal visible={popUp} transparent animationType="fade" onRequestClose={dismiss}>
      <View style={styles.overlay}>
        <View style={styles.dialog} accessibilityRole="alert">
          <View style={styles.header}>
            <Ionicons name="calendar" size={16} color={colors.blue600} />
            <Text style={styles.dialogTitle}>Scheduling note</Text>
          </View>
          <Text style={styles.dialogContent}>{note.content}</Text>
          <Text style={styles.meta}>{author} · {when}</Text>
          <TouchableOpacity style={styles.okBtn} onPress={dismiss} accessibilityLabel="Dismiss scheduling note">
            <Text style={styles.okText}>Got it</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
    <View style={styles.banner}>
      <View style={styles.header}>
        <Ionicons name="calendar" size={14} color={colors.blue600} />
        <Text style={styles.headerText}>Scheduling note</Text>
      </View>
      <Text style={styles.content}>{note.content}</Text>
      <Text style={styles.meta}>
        {author} · {when}
      </Text>
    </View>
    </>
  );
}

const styles = StyleSheet.create({
  banner: { backgroundColor: colors.blue100, borderRadius: 10, padding: 12, marginBottom: 12, gap: 4 },
  header: { flexDirection: "row", alignItems: "center", gap: 6 },
  headerText: { fontSize: 12, fontWeight: "700", color: colors.blue600, textTransform: "uppercase" },
  content: { fontSize: 14, color: colors.slate900 },
  meta: { fontSize: 11, color: colors.slate400 },
  overlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "center", padding: 24 },
  dialog: { backgroundColor: colors.card, borderRadius: 14, padding: 18, gap: 10 },
  dialogTitle: { fontSize: 13, fontWeight: "800", color: colors.blue600, textTransform: "uppercase" },
  dialogContent: { fontSize: 16, color: colors.slate900, lineHeight: 22 },
  okBtn: { marginTop: 6, backgroundColor: colors.blue600, borderRadius: 10, paddingVertical: 12, alignItems: "center" },
  okText: { color: "#fff", fontWeight: "700", fontSize: 15 },
});
