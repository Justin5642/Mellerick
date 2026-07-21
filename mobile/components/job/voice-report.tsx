import { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Alert, ActivityIndicator } from "react-native";
import { useAudioRecorder, useAudioRecorderState, AudioModule, RecordingPresets, setAudioModeAsync } from "expo-audio";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { useVoiceReport } from "../../lib/data/hooks/useVoiceReport";

// CRM spec item "Job Completion and Voice Report": a tech records a short
// voice summary of the job which gets uploaded to the private job-audio
// bucket and transcribed server-side via OpenAI Whisper
// (app/api/jobs/[id]/transcribe-voice-report on the web app), so the office
// gets a readable summary without listening to the recording. Optional —
// doesn't block job completion/signature. Now durable/offline-first: the
// recording is queued and transcribes on reconnect; the transcript appears on
// the next job-detail load.

export function VoiceReportRecorder({
  jobId,
  currentUserId,
  existingTranscript,
  onSaved,
}: {
  jobId: string;
  currentUserId: string;
  existingTranscript?: string | null;
  onSaved?: (transcript: string) => void;
}) {
  const audioRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const recorderState = useAudioRecorderState(audioRecorder);
  const [uploading, setUploading] = useState(false);
  const [transcript] = useState<string | null>(existingTranscript ?? null);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const voice = useVoiceReport();

  async function startRecording() {
    setError(null);
    const perm = await AudioModule.requestRecordingPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Microphone permission needed", "Enable microphone access in Settings to record a voice report.");
      return;
    }
    await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
    await audioRecorder.prepareToRecordAsync();
    audioRecorder.record();
  }

  async function stopRecording() {
    await audioRecorder.stop();
    const uri = audioRecorder.uri;
    if (!uri) return;
    await queueRecording(uri);
  }

  // Durable: queue the recording + transcription through the outbox. Online it
  // uploads + transcribes right away; offline it syncs on reconnect. The
  // transcript itself is written to the job server-side and shows on the next
  // job-detail load, so we confirm "saved" rather than displaying it inline.
  async function queueRecording(uri: string) {
    if (!voice.ready) return;
    setUploading(true);
    setError(null);
    try {
      await voice.record({ jobId, recordedBy: currentUserId, sourceUri: uri });
      setQueued(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save recording.");
    } finally {
      setUploading(false);
    }
  }

  if (transcript) {
    return (
      <View style={styles.card}>
        <View style={styles.doneRow}>
          <Ionicons name="checkmark-circle" size={16} color={colors.green600} />
          <Text style={styles.doneTitle}>Voice report recorded</Text>
        </View>
        <Text style={styles.transcript}>{transcript}</Text>
      </View>
    );
  }

  if (queued) {
    return (
      <View style={styles.card}>
        <View style={styles.doneRow}>
          <Ionicons name="checkmark-circle" size={16} color={colors.green600} />
          <Text style={styles.doneTitle}>Voice report saved</Text>
        </View>
        <Text style={styles.transcript}>It'll be transcribed for the office automatically once online.</Text>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <Text style={styles.title}>Voice Report (optional)</Text>
      <Text style={styles.hint}>Record a quick summary of the job — it'll be transcribed automatically for the office.</Text>
      {uploading ? (
        <View style={styles.uploadingRow}>
          <ActivityIndicator color={colors.blue600} />
          <Text style={styles.uploadingText}>Transcribing...</Text>
        </View>
      ) : (
        <TouchableOpacity
          style={[styles.recordButton, recorderState.isRecording && styles.recordButtonActive]}
          onPress={recorderState.isRecording ? stopRecording : startRecording}
        >
          <Ionicons name={recorderState.isRecording ? "stop-circle" : "mic"} size={18} color={recorderState.isRecording ? "#fff" : colors.blue600} />
          <Text style={[styles.recordButtonText, recorderState.isRecording && styles.recordButtonTextActive]}>
            {recorderState.isRecording ? "Stop Recording" : "Start Recording"}
          </Text>
        </TouchableOpacity>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
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
  uploadingRow: { flexDirection: "row", alignItems: "center", gap: 8, justifyContent: "center", paddingVertical: 12 },
  uploadingText: { color: colors.slate500, fontSize: 13 },
  error: { color: colors.red600, fontSize: 12, marginTop: 8 },
  doneRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 6 },
  doneTitle: { fontSize: 13, fontWeight: "700", color: colors.green600 },
  transcript: { fontSize: 13, color: colors.slate700, lineHeight: 19 },
});
