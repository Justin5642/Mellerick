// "Schedule an existing job" on the office Schedule tab (Justin's notebook
// list, 20 Nov 2026; office/admin — the tab lives in the (office) route
// group). Searches open jobs on the server as you type (online only, at most
// 20 — lib/data/reads/scheduleSearch.ts) and hands the picked one back; the
// screen then asks for a technician's day on the grid (or skips it) and opens
// the job's Schedule Job sheet. No money anywhere here.
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { KeyboardSheet, KEYBOARD_SHEET_INPUT_FONT_SIZE } from "../KeyboardSheet";
import { colors } from "../../lib/theme";
import { isScheduleSearchable } from "../../lib/scheduleExistingJob";
import { searchSchedulableJobs, type SchedulableJob } from "../../lib/data/reads/scheduleSearch";

export function ScheduleExistingSheet({
  visible,
  onClose,
  onPick,
}: {
  visible: boolean;
  onClose: () => void;
  onPick: (job: SchedulableJob) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SchedulableJob[]>([]);
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState(false);
  const seq = useRef(0);
  const term = query.trim();

  useEffect(() => {
    if (!visible) setQuery("");
  }, [visible]);

  useEffect(() => {
    if (!visible || !isScheduleSearchable(term)) {
      setResults([]);
      setSearching(false);
      setFailed(false);
      return;
    }
    const mine = ++seq.current;
    setSearching(true);
    const t = setTimeout(() => {
      searchSchedulableJobs(term)
        .then((rows) => {
          if (mine !== seq.current) return;
          setResults(rows);
          setFailed(false);
        })
        .catch(() => {
          if (mine !== seq.current) return;
          setResults([]);
          setFailed(true);
        })
        .finally(() => {
          if (mine === seq.current) setSearching(false);
        });
    }, 300);
    return () => clearTimeout(t);
  }, [term, visible]);

  return (
    <KeyboardSheet
      visible={visible}
      onRequestClose={onClose}
      title={<Text style={styles.title}>Schedule an existing job</Text>}
      footer={
        <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
          <Text style={styles.closeText}>Close</Text>
        </TouchableOpacity>
      }
    >
      <TextInput
        style={styles.input}
        value={query}
        onChangeText={setQuery}
        placeholder="Job number, title or customer"
        placeholderTextColor={colors.slate400}
        autoCorrect={false}
        accessibilityLabel="Find a job to schedule"
      />
      {term.length === 0 ? (
        <Text style={styles.muted}>Open jobs only — completed and cancelled jobs can&apos;t be scheduled. Needs signal.</Text>
      ) : searching ? (
        <ActivityIndicator style={{ marginTop: 12 }} color={colors.blue600} />
      ) : failed ? (
        <Text style={styles.error}>Couldn&apos;t search jobs — check your signal and try again.</Text>
      ) : !isScheduleSearchable(term) ? (
        <Text style={styles.muted}>Keep typing…</Text>
      ) : results.length === 0 ? (
        <Text style={styles.muted}>No open jobs match.</Text>
      ) : (
        results.map((job) => (
          <TouchableOpacity key={job.id} style={styles.row} onPress={() => onPick(job)} accessibilityRole="button">
            <Ionicons name="calendar-outline" size={18} color={colors.blue600} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle} numberOfLines={1}>#{job.job_number} — {job.title}</Text>
              <Text style={styles.rowMeta} numberOfLines={1}>
                {[job.customer_name ?? "No customer", job.suburb, job.status.replace("_", " "), job.booked ? "already booked" : null].filter(Boolean).join(" · ")}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.slate400} />
          </TouchableOpacity>
        ))
      )}
    </KeyboardSheet>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 16, fontWeight: "800", color: colors.slate900, marginBottom: 12 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: KEYBOARD_SHEET_INPUT_FONT_SIZE, backgroundColor: colors.bg, color: colors.slate900 },
  muted: { marginTop: 12, fontSize: 13, color: colors.slate500 },
  error: { marginTop: 12, fontSize: 13, color: colors.red600 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  rowTitle: { fontSize: 14, fontWeight: "600", color: colors.slate900 },
  rowMeta: { fontSize: 12, color: colors.slate500, marginTop: 2 },
  closeBtn: { paddingVertical: 12, borderRadius: 10, alignItems: "center", borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  closeText: { color: colors.slate700, fontWeight: "600", fontSize: 14 },
});
