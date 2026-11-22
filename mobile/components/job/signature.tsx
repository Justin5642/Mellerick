import { useEffect, useMemo, useRef, useState } from "react";
import { View, Text, StyleSheet, TextInput, TouchableOpacity, Alert, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Signature, { SignatureViewRef } from "react-native-signature-canvas";
import { colors } from "../../lib/theme";
import { VoiceReportRecorder } from "./voice-report";
import { useSignoff } from "../../lib/data/hooks/useSignoff";
import { readCachedProfile } from "../../lib/profileCache";
import { FinishForToday } from "./finish-for-today";
import { loadJobStages, type JobStageStatus } from "../../lib/jobStages";
import { getOpenWorkEntryOnJob } from "../../lib/data/reads/clock";
import { businessTodayKey } from "../../lib/scheduleDisplay";
import type { StageSignOff } from "../../lib/data/repositories/signature";
import {
  completionMode,
  defaultStageTicks,
  openStages,
  planStageCompletion,
  stageCompletionConfirm,
  stagesStillOpenMessage,
  STAGES_UNCHECKED_WARNING,
  type CompletionPlan,
  type StageBooking,
} from "../../lib/stageCompletion";

// Most jobs finish with nobody home (Justin, 2 Nov 2026: "9 times out of 10,
// the customer is not there"), so the technician signing off themselves is the
// default. A customer who is there can still sign on the glass.
type SignoffMode = "technician" | "customer";

// A multi-day job opens on "Finish for today" (Justin, 4 Nov 2026); "Job
// complete" is for the last day.
type Step = "today" | "complete";

// A job with two or more open stages (its builder PO's lines) completes per
// stage (Justin, 22 Nov 2026): the ticked stages close and the job stays open
// for the rest, unless every open stage is ticked. Rule in
// lib/stageCompletion.ts. The stage list needs signal; without it the sign-off
// closes the whole job, as before, and says so.
type OkPlan = Extract<CompletionPlan, { ok: true }>;

function toStageSignOff(plan: OkPlan, stages: JobStageStatus[] | null): StageSignOff | undefined {
  if (!stages) return undefined;
  const byId = new Map(stages.map((s) => [s.id, s.name]));
  return {
    completed: plan.stageIds.map((id) => ({ id, name: byId.get(id) ?? "" })),
    closesJob: plan.closesJob,
    remainingNames: plan.remainingNames,
  };
}

export function JobSignatureTab({
  jobId,
  currentUserId,
  existingSignature,
  existingVoiceTranscript,
  multiDay = false,
  myBookings = null,
  onCompleted,
}: {
  jobId: string;
  currentUserId: string;
  existingSignature?: string | null;
  existingVoiceTranscript?: string | null;
  /** Booked over several days and not on its last: open on Finish for today. */
  multiDay?: boolean;
  /** The signer's own bookings on this job, to pre-tick today's stage. */
  myBookings?: StageBooking[] | null;
  onCompleted?: () => void;
}) {
  const ref = useRef<SignatureViewRef>(null);
  const [signerName, setSignerName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [clockedOut, setClockedOut] = useState(false);
  const [mode, setMode] = useState<SignoffMode>("technician");
  const [step, setStep] = useState<Step>(multiDay ? "today" : "complete");
  const signoff = useSignoff();
  const [stages, setStages] = useState<JobStageStatus[] | null>(null);
  const [stagesError, setStagesError] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [stagesOnly, setStagesOnly] = useState<OkPlan | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [list, open] = await Promise.all([
          loadJobStages(jobId),
          getOpenWorkEntryOnJob(currentUserId, jobId).catch(() => null),
        ]);
        if (!live) return;
        setStages(list);
        setPicked(new Set(defaultStageTicks(list, myBookings, businessTodayKey(), open?.costCenterId ?? null)));
      } catch {
        if (live) setStagesError(true);
      }
    })();
    return () => {
      live = false;
    };
    // The defaults are set once, when the list arrives; a later bookings
    // reload must not untick what the technician chose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, currentUserId]);

  const perStage = stages !== null && completionMode(stages) === "per-stage";
  const stagesLoading = stages === null && !stagesError;
  const plan = useMemo(() => planStageCompletion(stages, picked), [stages, picked]);

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** The plan to save, or null after saying what's missing. */
  function checkedPlan(): OkPlan | null {
    if (stagesLoading) {
      Alert.alert("One moment", "Still checking the job's stages.");
      return null;
    }
    if (!plan.ok) {
      Alert.alert("Pick a stage", plan.problem);
      return null;
    }
    return plan;
  }

  function finished(p: OkPlan, result: { clockedOut: boolean }) {
    setClockedOut(result.clockedOut);
    if (p.closesJob) setSaved(true);
    else setStagesOnly(p);
  }

  function confirmTechnicianSignoff() {
    const p = checkedPlan();
    if (!p) return;
    if (perStage) {
      const c = stageCompletionConfirm(p);
      Alert.alert(c.title, `${c.message}\n\nSigned off in your name, without the customer.`, [
        { text: "Cancel", style: "cancel" },
        { text: c.button, onPress: () => void completeAsTechnician(p) },
      ]);
      return;
    }
    const warn = stagesError ? `\n\n${STAGES_UNCHECKED_WARNING}` : "";
    Alert.alert("Complete this job?", `It's signed off in your name, without the customer, and goes to the office to invoice.${warn}`, [
      { text: "Cancel", style: "cancel" },
      { text: "Complete job", onPress: () => void completeAsTechnician(p) },
    ]);
  }

  async function completeAsTechnician(p: OkPlan) {
    if (!signoff.ready || saving) return;
    setSaving(true);
    try {
      // From the cached profile so it works with no signal.
      const me = await readCachedProfile(currentUserId).catch(() => null);
      const result = await signoff.completeAsTechnician({
        jobId,
        staffId: currentUserId,
        technicianName: me?.full_name ?? null,
        signedOffDate: new Date().toLocaleDateString("en-AU"),
        stages: toStageSignOff(p, stages),
      });
      finished(p, result);
      onCompleted?.();
    } catch (e) {
      Alert.alert("Error", e instanceof Error ? e.message : "Couldn't complete the job");
    } finally {
      setSaving(false);
    }
  }

  async function handleOK(signature: string) {
    if (!signoff.ready) return;
    const p = checkedPlan();
    if (!p) return;
    setSaving(true);
    try {
      // Queue the compound job-completion write (signature image + jobs update +
      // calendar resync). Durable: a sign-off with no signal completes now and
      // syncs on reconnect.
      const base64 = signature.replace(/^data:image\/png;base64,/, "");
      const result = await signoff.signOff({
        jobId,
        uploadedBy: currentUserId,
        signerName,
        signatureBase64: base64,
        signedOffDate: new Date().toLocaleDateString("en-AU"),
        stages: toStageSignOff(p, stages),
      });
      finished(p, result);
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
    const p = checkedPlan();
    if (!p) return;
    if (perStage) {
      const c = stageCompletionConfirm(p);
      Alert.alert(c.title, c.message, [
        { text: "Cancel", style: "cancel" },
        { text: c.button, onPress: () => ref.current?.readSignature() },
      ]);
      return;
    }
    ref.current?.readSignature();
  }

  if (stagesOnly) {
    return (
      <View style={styles.container}>
        <View style={styles.doneCard}>
          <Text style={styles.doneTitle}>✅ Stage complete: {stagesOnly.stageNames.join(", ")}</Text>
          <Text style={styles.doneSubtitle}>{stagesStillOpenMessage(stagesOnly.remainingNames)}</Text>
          {clockedOut && <Text style={styles.doneSubtitle}>{"You've been clocked off this job."}</Text>}
        </View>
        <VoiceReportRecorder jobId={jobId} currentUserId={currentUserId} existingTranscript={existingVoiceTranscript} />
      </View>
    );
  }

  const open = openStages(stages);
  const doneStages = (stages ?? []).filter((st) => st.completedAt);
  const completeLabel = perStage && plan.ok && !plan.closesJob ? "Stage complete" : "Complete Job";
  const stagesPanel = (
    <>
      {stagesLoading && (
        <View style={styles.checkingRow}>
          <ActivityIndicator color={colors.blue600} />
          <Text style={styles.hint}>{"Checking the job's stages…"}</Text>
        </View>
      )}
      {stagesError && <Text style={styles.warn}>{STAGES_UNCHECKED_WARNING}</Text>}
      {perStage && (
        <>
          <Text style={styles.label}>Which stages are complete?</Text>
          {open.map((st) => {
            const on = picked.has(st.id);
            return (
              <TouchableOpacity
                key={st.id}
                style={[styles.stageRow, on && styles.stageRowOn]}
                onPress={() => toggle(st.id)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={`${st.name} complete`}
              >
                <Ionicons name={on ? "checkbox" : "square-outline"} size={24} color={on ? colors.blue600 : colors.slate400} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.stageName}>{st.name}</Text>
                  {st.costCentre && <Text style={styles.stageMeta}>{st.costCentre}</Text>}
                </View>
              </TouchableOpacity>
            );
          })}
          {doneStages.map((st) => (
            <View key={st.id} style={styles.stageRow}>
              <Ionicons name="checkmark-circle" size={24} color={colors.green600} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.stageName, { color: colors.slate500 }]}>{st.name}</Text>
                <Text style={styles.stageMeta}>Complete {new Date(st.completedAt as string).toLocaleDateString("en-AU")}</Text>
              </View>
            </View>
          ))}
          <Text style={styles.hint}>
            {!plan.ok
              ? plan.problem
              : plan.closesJob
                ? "Every open stage is ticked, so this completes the whole job."
                : stagesStillOpenMessage(plan.remainingNames)}
          </Text>
        </>
      )}
    </>
  );

  if (saved || existingSignature) {
    return (
      <View style={styles.container}>
        <View style={styles.doneCard}>
          <Text style={styles.doneTitle}>✅ Job Signed Off</Text>
          {existingSignature && <Text style={styles.doneSubtitle}>{existingSignature}</Text>}
          {clockedOut && <Text style={styles.doneSubtitle}>{"You've been clocked off this job."}</Text>}
        </View>
        <VoiceReportRecorder jobId={jobId} currentUserId={currentUserId} existingTranscript={existingVoiceTranscript} />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <VoiceReportRecorder jobId={jobId} currentUserId={currentUserId} existingTranscript={existingVoiceTranscript} />

      <View style={styles.modeRow}>
        {(
          [
            ["today", "Finish for today"],
            ["complete", "Job complete"],
          ] as const
        ).map(([st, label]) => (
          <TouchableOpacity
            key={st}
            style={[styles.modeBtn, step === st && styles.modeBtnActive]}
            onPress={() => setStep(st)}
            accessibilityLabel={label}
          >
            <Text style={[styles.modeText, step === st && styles.modeTextActive]}>{label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {step === "today" ? (
        <FinishForToday jobId={jobId} currentUserId={currentUserId} onFinished={onCompleted} />
      ) : (
        <>
          <Text style={styles.label}>Who is signing off?</Text>
          <View style={styles.modeRow}>
            {(
              [
                ["technician", "Me (customer not here)"],
                ["customer", "The customer"],
              ] as const
            ).map(([m, label]) => (
              <TouchableOpacity
                key={m}
                style={[styles.modeBtn, mode === m && styles.modeBtnActive]}
                onPress={() => setMode(m)}
                accessibilityLabel={label}
              >
                <Text style={[styles.modeText, mode === m && styles.modeTextActive]}>{label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {mode === "technician" ? (
            <>
              <Text style={styles.hint}>No customer name or signature needed. The office sees you signed it off.</Text>
              {stagesPanel}
              <TouchableOpacity style={styles.saveButton} onPress={confirmTechnicianSignoff} disabled={saving || stagesLoading}>
                <Text style={styles.saveButtonText}>{saving ? "Saving..." : completeLabel}</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
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
              {stagesPanel}

              <TouchableOpacity style={styles.saveButton} onPress={handleSavePress} disabled={saving || stagesLoading}>
                <Text style={styles.saveButtonText}>{saving ? "Saving..." : `Save & ${completeLabel}`}</Text>
              </TouchableOpacity>
            </>
          )}
        </>
      )}
    </View>
  );
}

export const signatureWebStyle = `
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
  modeRow: { flexDirection: "row", gap: 8 },
  modeBtn: { flex: 1, paddingVertical: 12, paddingHorizontal: 6, borderRadius: 10, alignItems: "center", backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  modeBtnActive: { backgroundColor: colors.blue600, borderColor: colors.blue600 },
  modeText: { fontSize: 14, fontWeight: "700", color: colors.slate700, textAlign: "center" },
  modeTextActive: { color: "#fff" },
  doneCard: { backgroundColor: colors.green100, borderRadius: 12, padding: 20, alignItems: "center" },
  doneTitle: { fontSize: 16, fontWeight: "700", color: colors.green600 },
  doneSubtitle: { fontSize: 13, color: colors.green600, marginTop: 6, textAlign: "center" },
  warn: { fontSize: 13, color: colors.orange700, marginTop: 10, fontWeight: "600" },
  checkingRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 },
  stageRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12, paddingHorizontal: 10, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, marginBottom: 6 },
  stageRowOn: { borderColor: colors.blue600, backgroundColor: "#eff6ff" },
  stageName: { fontSize: 15, fontWeight: "600", color: colors.slate900 },
  stageMeta: { fontSize: 12, color: colors.slate500, marginTop: 1 },
});
