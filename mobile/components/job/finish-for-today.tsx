import { useEffect, useState } from "react";
import { View, Text, StyleSheet, TextInput, TouchableOpacity, Alert, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { useSignoff } from "../../lib/data/hooks/useSignoff";
import { loadJobStages, type JobStageStatus } from "../../lib/jobStages";

// End of a day on a multi-day job (Justin, 4 Nov 2026: "how do we have a sign
// off for multi day jobs rather than signing the job as complete"). A short
// note of what was done and what's left, any stage of the builder's PO that
// is now finished (so the office can claim it), and the clock stops. The job
// stays open. Works with no signal: the note and the stages queue on the
// phone; only the list of stages needs signal to load.

export function FinishForToday({
  jobId,
  currentUserId,
  onFinished,
}: {
  jobId: string;
  currentUserId: string;
  onFinished?: () => void;
}) {
  const signoff = useSignoff();
  const [note, setNote] = useState("");
  const [stages, setStages] = useState<JobStageStatus[] | null>(null);
  const [stagesError, setStagesError] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<{ clockedOut: boolean; stages: string[] } | null>(null);

  useEffect(() => {
    loadJobStages(jobId)
      .then((s) => setStages(s))
      .catch(() => setStagesError(true));
  }, [jobId]);

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function finish() {
    if (saving || !signoff.ready) return;
    const chosen = (stages ?? []).filter((s) => picked.has(s.id)).map((s) => ({ id: s.id, name: s.name }));
    setSaving(true);
    try {
      const result = await signoff.finishForToday({ jobId, staffId: currentUserId, note, stages: chosen });
      setDone({ clockedOut: result.clockedOut, stages: chosen.map((s) => s.name) });
      onFinished?.();
    } catch (e) {
      Alert.alert("Not saved", e instanceof Error ? e.message : "Try again.");
    } finally {
      setSaving(false);
    }
  }

  if (done) {
    return (
      <View style={styles.doneCard}>
        <Text style={styles.doneTitle}>✅ Finished for today</Text>
        {done.stages.length > 0 && <Text style={styles.doneSubtitle}>Stage complete: {done.stages.join(", ")}</Text>}
        <Text style={styles.doneSubtitle}>
          {done.clockedOut ? "You've been clocked off. " : ""}The job stays open for tomorrow.
        </Text>
      </View>
    );
  }

  const open = (stages ?? []).filter((s) => !s.completedAt);
  const finished = (stages ?? []).filter((s) => s.completedAt);

  return (
    <View>
      <Text style={styles.label}>{"What got done today, and what's left?"}</Text>
      <TextInput
        style={[styles.input, styles.textArea]}
        value={note}
        onChangeText={setNote}
        placeholder="e.g. Sewer laid to the boundary. Hook-up tomorrow."
        placeholderTextColor={colors.slate400}
        multiline
      />

      <Text style={styles.label}>Any stage finished today?</Text>
      {stages === null && !stagesError && <ActivityIndicator color={colors.blue600} style={{ alignSelf: "flex-start" }} />}
      {stagesError && <Text style={styles.hint}>{"Stages need signal to load. You can still finish for today."}</Text>}
      {stages && stages.length === 0 && <Text style={styles.hint}>This job has no stages on its builder PO.</Text>}
      {open.map((s) => {
        const on = picked.has(s.id);
        return (
          <TouchableOpacity
            key={s.id}
            style={[styles.stageRow, on && styles.stageRowOn]}
            onPress={() => toggle(s.id)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on }}
            accessibilityLabel={`${s.name} complete`}
          >
            <Ionicons name={on ? "checkbox" : "square-outline"} size={24} color={on ? colors.blue600 : colors.slate400} />
            <View style={{ flex: 1 }}>
              <Text style={styles.stageName}>{s.name}</Text>
              {s.costCentre && <Text style={styles.stageMeta}>{s.costCentre}</Text>}
            </View>
          </TouchableOpacity>
        );
      })}
      {finished.map((s) => (
        <View key={s.id} style={styles.stageRow}>
          <Ionicons name="checkmark-circle" size={24} color={colors.green600} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.stageName, { color: colors.slate500 }]}>{s.name}</Text>
            <Text style={styles.stageMeta}>
              Complete {new Date(s.completedAt as string).toLocaleDateString("en-AU")}
              {s.completedBy ? ` · ${s.completedBy}` : ""}
            </Text>
          </View>
        </View>
      ))}

      <TouchableOpacity style={styles.button} onPress={finish} disabled={saving}>
        <Text style={styles.buttonText}>{saving ? "Saving..." : "Finish for today"}</Text>
      </TouchableOpacity>
      <Text style={styles.hint}>{"Clocks you off. The job stays open — use Job complete on the last day."}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 13, fontWeight: "600", color: colors.slate700, marginBottom: 6, marginTop: 12 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    backgroundColor: colors.card,
    color: colors.slate900,
  },
  textArea: { minHeight: 80, textAlignVertical: "top" },
  hint: { fontSize: 12, color: colors.slate500, marginTop: 6 },
  stageRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12, paddingHorizontal: 10, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, marginBottom: 6 },
  stageRowOn: { borderColor: colors.blue600, backgroundColor: "#eff6ff" },
  stageName: { fontSize: 15, fontWeight: "600", color: colors.slate900 },
  stageMeta: { fontSize: 12, color: colors.slate500, marginTop: 1 },
  button: { backgroundColor: colors.blue600, borderRadius: 10, paddingVertical: 14, alignItems: "center", marginTop: 16 },
  buttonText: { color: "#fff", fontWeight: "600", fontSize: 15 },
  doneCard: { backgroundColor: colors.green100, borderRadius: 12, padding: 20, alignItems: "center", marginTop: 12 },
  doneTitle: { fontSize: 16, fontWeight: "700", color: colors.green600 },
  doneSubtitle: { fontSize: 13, color: colors.green600, marginTop: 6, textAlign: "center" },
});
