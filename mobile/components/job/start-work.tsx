import { useRef, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Alert, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Crypto from "expo-crypto";
import { colors } from "../../lib/theme";
import { KeyboardSheet } from "../KeyboardSheet";
import { StageList } from "./clock-on-stage-picker";
import { useTimeClock } from "../../lib/data/hooks/useTimeClock";
import { netInfoConnectivity } from "../../lib/data/net/connectivity";
import { currentFix } from "../../lib/clockFix";
import { offerSitePinAfterClockOn } from "../../lib/sitePinOffer";
import { loadStartStages, startWorkOnJob, type StartedBooking } from "../../lib/startWork";
import {
  NO_OPEN_STAGES,
  openStartStages,
  preselectedStartStage,
  startStageLabel,
  startStageProblem,
  startWorkQuestion,
  type StartStage,
} from "../../lib/selfStartBooking";

// "Start work on this job" — on a job a technician is NOT on (Justin, 25 Nov
// 2026): "they can pop in and see a job needs something done … search the
// job, clock onto it … we need it to show up in schedule". Pick the stage
// (mandatory: the only open one is preselected, with several NOTHING is), a
// confirm naming it, then the server makes their booking from now (0118) and
// the phone clocks on to the same stage through the outbox. The booking ends
// when they clock off. Online only.

export function StartWorkButton({
  jobId,
  jobNumber,
  currentUserId,
  onStarted,
}: {
  jobId: string;
  jobNumber: number | null;
  currentUserId: string;
  onStarted: (booking: StartedBooking, stageName: string) => void;
}) {
  const timeClock = useTimeClock();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [stages, setStages] = useState<StartStage[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Kept across a retry of the same start (a lost answer must not book twice).
  const ids = useRef<{ bookingId: string; entryId: string; costCenterId: string } | null>(null);

  async function openPicker() {
    if (loading) return;
    if (!(await netInfoConnectivity.isOnline())) {
      Alert.alert("Starting work needs signal", "Try again when you have signal — the booking is made on the server before you clock on.");
      return;
    }
    setLoading(true);
    try {
      const res = await loadStartStages(jobId);
      if (res.job.closed) {
        Alert.alert("Can't start this job", `Job #${res.job.jobNumber ?? ""} is ${res.job.status}. Ask the office to reopen it.`);
        return;
      }
      setStages(res.stages);
      setPicked(preselectedStartStage(res.stages));
      setOpen(true);
    } catch (e) {
      Alert.alert("Couldn't load the job's cost centres", e instanceof Error ? e.message : "Try again.");
    } finally {
      setLoading(false);
    }
  }

  function confirm() {
    const problem = startStageProblem(stages, picked);
    if (problem) {
      Alert.alert("Pick a cost centre", problem);
      return;
    }
    const stage = stages!.find((s) => s.id === picked)!;
    Alert.alert(startWorkQuestion(jobNumber, stage), "You'll be booked on this job from now until you clock off, and the office will see it on the schedule.", [
      { text: "Cancel", style: "cancel" },
      { text: "Clock on", onPress: () => void start(stage) },
    ]);
  }

  async function start(stage: StartStage) {
    if (busy || !timeClock.ready) return;
    setBusy(true);
    if (!ids.current || ids.current.costCenterId !== stage.id) {
      ids.current = { bookingId: Crypto.randomUUID(), entryId: Crypto.randomUUID(), costCenterId: stage.id };
    }
    const { bookingId, entryId } = ids.current;
    try {
      const res = await startWorkOnJob(jobId, { bookingId, costCenterId: stage.id, entryId });
      const fix = await currentFix(3000);
      // The same stage, and the entry id the booking follows.
      await timeClock.clockIn({ jobId, staffId: currentUserId, costCenterId: stage.id, fix, id: entryId });
      ids.current = null;
      setOpen(false);
      onStarted(res.booking, startStageLabel(stage));
      void offerSitePinAfterClockOn(jobId, fix);
    } catch (e) {
      Alert.alert("Couldn't start work", e instanceof Error ? e.message : "Try again.");
    } finally {
      setBusy(false);
    }
  }

  const open_ = openStartStages(stages);

  return (
    <View style={styles.wrap}>
      <TouchableOpacity style={styles.button} onPress={() => void openPicker()} disabled={loading} accessibilityRole="button" accessibilityLabel="Start work on this job">
        {loading ? <ActivityIndicator color="#fff" /> : <Ionicons name="play-circle-outline" size={20} color="#fff" />}
        <Text style={styles.buttonText}>Start work on this job</Text>
      </TouchableOpacity>
      <Text style={styles.hint}>{"Doing something here while you're nearby? Clock on and it goes on the schedule for you."}</Text>

      <KeyboardSheet
        visible={open}
        onRequestClose={() => !busy && setOpen(false)}
        title="Which cost centre are you working on?"
        footer={
          <View style={styles.footer}>
            <TouchableOpacity style={[styles.btn, styles.btnPlain]} onPress={() => setOpen(false)} disabled={busy}>
              <Text style={styles.btnPlainText}>Cancel</Text>
            </TouchableOpacity>
            {open_.length > 0 && (
              <TouchableOpacity
                style={[styles.btn, styles.btnMain, (!picked || busy) && styles.btnOff]}
                disabled={!picked || busy}
                onPress={confirm}
                accessibilityLabel="Clock on"
              >
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnMainText}>Clock on</Text>}
              </TouchableOpacity>
            )}
          </View>
        }
      >
        {open_.length === 0 ? (
          <Text style={styles.warn}>{NO_OPEN_STAGES}</Text>
        ) : (
          <>
            <Text style={styles.sheetHint}>
              {open_.length === 1 ? "This job has one open cost centre." : "Tap the one you're doing — your hours go against it."}
            </Text>
            <StageList stages={open_} selectedId={picked} onSelect={setPicked} />
          </>
        )}
      </KeyboardSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { margin: 12, marginBottom: 0, gap: 6 },
  button: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, backgroundColor: colors.green600, paddingVertical: 14, borderRadius: 12 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  hint: { fontSize: 12, color: colors.slate500, textAlign: "center" },
  sheetHint: { fontSize: 14, color: colors.slate500 },
  warn: { fontSize: 15, color: "#b45309", fontWeight: "600" },
  footer: { flexDirection: "row", gap: 10 },
  btn: { flex: 1, paddingVertical: 14, borderRadius: 10, alignItems: "center" },
  btnPlain: { backgroundColor: colors.slate100 },
  btnPlainText: { fontSize: 16, fontWeight: "700", color: colors.slate700 },
  btnMain: { backgroundColor: colors.blue600 },
  btnOff: { opacity: 0.4 },
  btnMainText: { fontSize: 16, fontWeight: "700", color: "#fff" },
});
