import { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Alert, ActivityIndicator } from "react-native";
import { useAudioRecorder, useAudioRecorderState, AudioModule, RecordingPresets, setAudioModeAsync } from "expo-audio";
import * as FileSystem from "expo-file-system/legacy";
import { decode } from "base64-arraybuffer";
import { Ionicons } from "@expo/vector-icons";
import { supabase } from "../../lib/supabase";
import { colors } from "../../lib/theme";

// CRM spec item "Job Completion and Voice Report": a tech records a short
// voice summary of the job which gets uploaded to the private job-audio
// bucket and transcribed server-side via OpenAI Whisper
// (app/api/jobs/[id]/transcribe-voice-report on the web app), so the office
// gets a readable summary without listening to the recording. Optional —
// doesn't block job completion/signature.
const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL;

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
  const [transcript, setTranscript] = useState<string | null>(existingTranscript ?? null);
  const [error, setError] = useState<string | null>(null);

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
    await uploadAndTranscribe(uri);
  }

  async function uploadAndTranscribe(uri: string) {
    if (!API_BASE_URL) {
      setError("App isn't configured to reach the office server for transcription.");
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
      const path = `${jobId}/voice-report-${Date.now()}.m4a`;
      const { error: uploadError } = await supabase.storage.from("job-audio").upload(path, decode(base64), {
        contentType: "audio/m4a",
      });
      if (uploadError) {
        setError("Failed to upload recording.");
        return;
      }
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) {
        setError("You are signed out — sign back in to transcribe the voice report.");
        return;
      }
      const res = await fetch(`${API_BASE_URL}/api/jobs/${jobId}/transcribe-voice-report`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ storagePath: path, recordedBy: currentUserId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Transcription failed.");
        return;
      }
      setTranscript(data.transcript);
      onSaved?.(data.transcript);
    } catch (e: any) {
      setError(e?.message ?? "Something went wrong.");
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
