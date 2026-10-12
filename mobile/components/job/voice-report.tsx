import { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { useVoiceReport } from "../../lib/data/hooks/useVoiceReport";
import { useDictation, type DictationResult } from "../../lib/dictation";
import { netInfoConnectivity } from "../../lib/data/net/connectivity";

// CRM spec item "Job Completion and Voice Report": a tech speaks a short
// summary of the job so the office gets a readable record. The words are
// recognised ON THE PHONE as the tech talks (lib/dictation.ts — no OpenAI);
// the tech reviews and can correct the text before saving. Where the phone
// can keep it (iOS, Android 13+) the recording uploads to the private
// job-audio bucket alongside. Optional — doesn't block job completion or
// signature. Durable/offline-first: everything is queued through the outbox.

export function VoiceReportRecorder({
  jobId,
  currentUserId,
  existingTranscript,
}: {
  jobId: string;
  currentUserId: string;
  existingTranscript?: string | null;
}) {
  const [draft, setDraft] = useState<DictationResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ transcript: string; synced: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const voice = useVoiceReport();
  const dictation = useDictation((result) => {
    if (!result.text) {
      setError("No speech was recognised. Try again.");
      return;
    }
    setDraft(result);
  });

  async function startRecording() {
    setError(null);
    setDraft(null);
    await dictation.start({ online: await netInfoConnectivity.isOnline(), persistAudio: true });
  }

  async function save() {
    if (!draft || !draft.text.trim() || !voice.ready) return;
    setSaving(true);
    setError(null);
    try {
      const { synced } = await voice.record({
        jobId,
        recordedBy: currentUserId,
        transcript: draft.text.trim(),
        sourceUri: draft.audioUri,
      });
      setSaved({ transcript: draft.text.trim(), synced });
      setDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save the voice report.");
    } finally {
      setSaving(false);
    }
  }

  const shownTranscript = saved?.transcript ?? existingTranscript ?? null;

  if (shownTranscript && !draft && !dictation.listening) {
    return (
      <View style={styles.card}>
        <View style={styles.doneRow}>
          <Ionicons name="checkmark-circle" size={16} color={colors.green600} />
          <Text style={styles.doneTitle}>
            {saved && !saved.synced ? "Voice report saved — sends when back online" : "Voice report recorded"}
          </Text>
        </View>
        <Text style={styles.transcript}>{shownTranscript}</Text>
        {dictation.available && (
          <TouchableOpacity onPress={startRecording} style={styles.rerecord}>
            <Text style={styles.rerecordText}>Record again</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  if (!dictation.available) {
    return (
      <View style={styles.card}>
        <Text style={styles.title}>Voice Report (optional)</Text>
        <Text style={styles.hint}>Update the app to record voice reports.</Text>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Voice Report (optional)</Text>
      {draft ? (
        <>
          <Text style={styles.hint}>Check the text, fix anything misheard, then save.</Text>
          <TextInput
            style={styles.input}
            value={draft.text}
            onChangeText={(text) => setDraft({ ...draft, text })}
            multiline
          />
          <View style={styles.row}>
            <TouchableOpacity style={[styles.recordButton, styles.flex]} onPress={startRecording} disabled={saving}>
              <Ionicons name="mic" size={18} color={colors.blue600} />
              <Text style={styles.recordButtonText}>Re-record</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.saveButton, styles.flex]}
              onPress={save}
              disabled={saving || !draft.text.trim()}
            >
              {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveButtonText}>Save report</Text>}
            </TouchableOpacity>
          </View>
        </>
      ) : (
        <>
          <Text style={styles.hint}>
            {dictation.listening
              ? "Listening… tap Stop when you're done."
              : "Tap Start and talk through the job — the words appear as you speak."}
          </Text>
          {dictation.listening && !!dictation.text && <Text style={styles.live}>{dictation.text}</Text>}
          <TouchableOpacity
            style={[styles.recordButton, dictation.listening && styles.recordButtonActive]}
            onPress={dictation.listening ? dictation.stop : startRecording}
          >
            <Ionicons name={dictation.listening ? "stop-circle" : "mic"} size={18} color={dictation.listening ? "#fff" : colors.blue600} />
            <Text style={[styles.recordButtonText, dictation.listening && styles.recordButtonTextActive]}>
              {dictation.listening ? "Stop" : "Start Recording"}
            </Text>
          </TouchableOpacity>
        </>
      )}
      {(error ?? dictation.error) && <Text style={styles.error}>{error ?? dictation.error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: colors.border, marginBottom: 16 },
  title: { fontSize: 13, fontWeight: "700", color: colors.slate700, marginBottom: 4 },
  hint: { fontSize: 12, color: colors.slate400, marginBottom: 12 },
  recordButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderWidth: 1,
    borderColor: colors.blue600,
    borderRadius: 10,
    paddingVertical: 12,
  },
  recordButtonActive: { backgroundColor: colors.red600, borderColor: colors.red600 },
  recordButtonText: { color: colors.blue600, fontWeight: "600", fontSize: 14 },
  recordButtonTextActive: { color: "#fff" },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 10,
    minHeight: 90,
    fontSize: 13,
    color: colors.slate700,
    textAlignVertical: "top",
    marginBottom: 10,
  },
  live: { fontSize: 13, color: colors.slate700, lineHeight: 19, marginBottom: 10 },
  row: { flexDirection: "row", gap: 8 },
  flex: { flex: 1 },
  saveButton: { backgroundColor: colors.blue600, borderRadius: 10, paddingVertical: 12, alignItems: "center", justifyContent: "center" },
  saveButtonText: { color: "#fff", fontWeight: "600", fontSize: 14 },
  rerecord: { marginTop: 8 },
  rerecordText: { color: colors.blue600, fontSize: 12, fontWeight: "600" },
  error: { color: colors.red600, fontSize: 12, marginTop: 8 },
  doneRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 },
  doneTitle: { fontSize: 13, fontWeight: "700", color: colors.green600 },
  transcript: { fontSize: 13, color: colors.slate700, lineHeight: 19 },
});
