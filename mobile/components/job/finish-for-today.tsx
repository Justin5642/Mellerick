import { useState } from "react";
import { View, Text, StyleSheet, TextInput, TouchableOpacity, Alert } from "react-native";
import { colors } from "../../lib/theme";
import { useSignoff } from "../../lib/data/hooks/useSignoff";

// End of a day on a multi-day job (Justin, 4 Nov 2026: "how do we have a sign
// off for multi day jobs rather than signing the job as complete"). A short
// note of what was done and what's left, and the clock stops. The job stays
// open. It never marks a stage complete (Justin, 22 Nov 2026: "They could be
// going back to that cost centre tomorrow") — that is the Stage / job
// complete step. Works with no signal: the note queues on the phone.

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
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<{ clockedOut: boolean } | null>(null);

  async function finish() {
    if (saving || !signoff.ready) return;
    setSaving(true);
    try {
      const result = await signoff.finishForToday({ jobId, staffId: currentUserId, note, stages: [] });
      setDone({ clockedOut: result.clockedOut });
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
        <Text style={styles.doneSubtitle}>
          {done.clockedOut ? "You've been clocked off. " : ""}The job stays open for tomorrow.
        </Text>
      </View>
    );
  }

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

      <TouchableOpacity style={styles.button} onPress={finish} disabled={saving}>
        <Text style={styles.buttonText}>{saving ? "Saving..." : "Finish for today"}</Text>
      </TouchableOpacity>
      <Text style={styles.hint}>{"Records today and clocks you off. No stage is marked complete — use Stage / job complete when a stage is finished."}</Text>
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
  button: { backgroundColor: colors.blue600, borderRadius: 10, paddingVertical: 14, alignItems: "center", marginTop: 16 },
  buttonText: { color: "#fff", fontWeight: "600", fontSize: 15 },
  doneCard: { backgroundColor: colors.green100, borderRadius: 12, padding: 20, alignItems: "center", marginTop: 12 },
  doneTitle: { fontSize: 16, fontWeight: "700", color: colors.green600 },
  doneSubtitle: { fontSize: 13, color: colors.green600, marginTop: 6, textAlign: "center" },
});
