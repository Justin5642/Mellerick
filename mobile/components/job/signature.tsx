import { useRef, useState } from "react";
import { View, Text, StyleSheet, TextInput, TouchableOpacity, Alert } from "react-native";
import Signature, { SignatureViewRef } from "react-native-signature-canvas";
import { colors } from "../../lib/theme";
import { VoiceReportRecorder } from "./voice-report";
import { useSignoff } from "../../lib/data/hooks/useSignoff";

export function JobSignatureTab({
  jobId,
  currentUserId,
  existingSignature,
  existingVoiceTranscript,
  onCompleted,
}: {
  jobId: string;
  currentUserId: string;
  existingSignature?: string | null;
  existingVoiceTranscript?: string | null;
  onCompleted?: () => void;
}) {
  const ref = useRef<SignatureViewRef>(null);
  const [signerName, setSignerName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const signoff = useSignoff();

  async function handleOK(signature: string) {
    if (!signoff.ready) return;
    setSaving(true);
    try {
      // Queue the compound job-completion write (signature image + jobs update +
      // calendar resync). Durable: a sign-off with no signal completes now and
      // syncs on reconnect.
      const base64 = signature.replace(/^data:image\/png;base64,/, "");
      await signoff.signOff({
        jobId,
        uploadedBy: currentUserId,
        signerName,
        signatureBase64: base64,
        signedOffDate: new Date().toLocaleDateString("en-AU"),
      });
      setSaved(true);
      onCompleted?.();
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "Failed to save signature");
    } finally {
      setSaving(false);
    }
  }

  function handleSavePress() {
    if (!signerName.trim()) {
      Alert.alert("Customer name required", "Please enter the customer's name before saving.");
      return;
    }
    ref.current?.readSignature();
  }

  if (saved || existingSignature) {
    return (
      <View style={styles.container}>
        <View style={styles.doneCard}>
          <Text style={styles.doneTitle}>✅ Job Signed Off</Text>
          {existingSignature && <Text style={styles.doneSubtitle}>{existingSignature}</Text>}
        </View>
        <VoiceReportRecorder jobId={jobId} currentUserId={currentUserId} existingTranscript={existingVoiceTranscript} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <VoiceReportRecorder jobId={jobId} currentUserId={currentUserId} existingTranscript={existingVoiceTranscript} />

      <Text style={styles.label}>Customer Name</Text>
      <TextInput
        style={styles.input}
        value={signerName}
        onChangeText={setSignerName}
        placeholder="e.g. John Smith"
      />

      <Text style={styles.label}>Signature</Text>
      <View style={styles.canvasWrap}>
        <Signature
          ref={ref}
          onOK={handleOK}
          onEmpty={() => Alert.alert("Signature required", "Please sign before saving.")}
          descriptionText=""
          clearText="Clear"
          confirmText="Confirm"
          webStyle={signatureWebStyle}
          autoClear={false}
        />
      </View>
      <Text style={styles.hint}>Sign above, then tap Confirm to complete the job.</Text>

      <TouchableOpacity style={styles.saveButton} onPress={handleSavePress} disabled={saving}>
        <Text style={styles.saveButtonText}>{saving ? "Saving..." : "Save & Complete Job"}</Text>
      </TouchableOpacity>
    </View>
  );
}

const signatureWebStyle = `
  .m-signature-pad--footer { display: flex; justify-content: space-between; padding: 8px; }
  .m-signature-pad--body { border: none; }
  body,html { background-color: #f8fafc; }
`;

const styles = StyleSheet.create({
  container: { padding: 16 },
  label: { fontSize: 13, fontWeight: "600", color: colors.slate700, marginBottom: 6, marginTop: 10 },
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
  canvasWrap: {
    height: 220,
    borderWidth: 2,
    borderColor: colors.border,
    borderRadius: 12,
    overflow: "hidden",
    backgroundColor: colors.bg,
  },
  hint: { fontSize: 11, color: colors.slate400, marginTop: 6 },
  saveButton: { backgroundColor: colors.blue600, borderRadius: 10, paddingVertical: 14, alignItems: "center", marginTop: 20 },
  saveButtonText: { color: "#fff", fontWeight: "600", fontSize: 15 },
  doneCard: { backgroundColor: colors.green100, borderRadius: 12, padding: 20, alignItems: "center" },
  doneTitle: { fontSize: 16, fontWeight: "700", color: colors.green600 },
  doneSubtitle: { fontSize: 13, color: colors.green600, marginTop: 6 },
});
