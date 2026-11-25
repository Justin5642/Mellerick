import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { View, Text, StyleSheet, TouchableOpacity, TextInput, Alert } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { Image } from "expo-image";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { KeyboardSheet } from "../KeyboardSheet";
import { manualClockOnCostCentre, type BookingWindow } from "../../lib/bookings";
import { listJobClockStages, type ClockStage } from "../../lib/data/reads/clockStages";
import { listJobClockVariations, openClockVariations, type ClockVariation } from "../../lib/data/reads/clockVariations";
import { startStageLabel } from "../../lib/selfStartBooking";
import { prepareImageForUpload } from "../../lib/imageUpload";
import type { NewVariationArgs } from "../../lib/data/hooks/useTimeClock";

// The cost centre of a MANUAL clock-on (Time tab, Today card) — Justin, 25 Nov
// 2026: "it is critical that they clock on to the correct cost centre". Their
// booking's stage when they have one; with no booking and two or more open
// stages it ASKS instead of guessing; completed stages are never used or
// offered (lib/bookings.ts manualClockOnCostCentre). The stage list is online
// (GET /api/jobs/[id]/stages); offline it behaves as before.
//
// Time against a variation (0120, draft — Justin, 25 Nov 2026: "when the crew
// hit rock … log that extra time against a variation"): the same sheet lists
// the job's open variations (not rejected; names and statuses only, never a
// price — lib/data/reads/clockVariations.ts, local-first so it works offline)
// and "+ New variation (e.g. hit rock)" — a name, details and a photo, logged
// as the Variations tab logs a custom one. The sheet shows when it must ask
// for a stage, when the job has open variations, or when asked for ("Clock on
// to a variation…", "Switch…"). Variation time never counts toward the stage's
// allowed hours.

/** A list of stages to tap, one of them selected. Shared with "Start work on this job". */
export function StageList({
  stages,
  selectedId,
  onSelect,
}: {
  stages: Pick<ClockStage, "id" | "name" | "costCentre">[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <View style={styles.list}>
      {stages.map((s) => {
        const on = s.id === selectedId;
        return (
          <TouchableOpacity
            key={s.id}
            style={[styles.row, on && styles.rowOn]}
            onPress={() => onSelect(s.id)}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            accessibilityLabel={startStageLabel(s)}
          >
            <Ionicons name={on ? "radio-button-on" : "radio-button-off"} size={22} color={on ? colors.blue600 : colors.slate500} />
            <Text style={[styles.rowText, on && styles.rowTextOn]}>{startStageLabel(s)}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

/** What a clock-on (or a switch) is for. */
export interface ClockOnPick {
  costCenterId: string | null;
  /** Time against this variation; null = the stage's own work. */
  variationId: string | null;
  /** A variation raised in the sheet (the clock-on waits for it). */
  newVariation: NewVariationArgs | null;
}

type Mode = "clock-on" | "switch";

interface Pending {
  mode: Mode;
  /** Stage rows to offer (ids of `stages`); empty = one "Stage work" row. */
  stageOptions: ClockStage[];
  /** The stage a "Stage work" pick uses when there's no list to pick from. */
  fallbackCostCenterId: string | null;
  variations: ClockVariation[];
  /** In switch mode: what they're on now (not offered again). */
  currentVariationId: string | null;
  resolve: (picked: ClockOnPick | undefined) => void;
}

// One radio key per row: "stage:<id>", "stage:", "var:<id>", "new".
type Key = string;

/**
 * `chooseClockOn(myBookings, scheduledCostCenterId, { force })` resolves to
 * what to clock on to, or `undefined` when they cancelled. `chooseSwitch`
 * is "Switch to a variation" / "Back to the stage" while clocked on. Render
 * `sheet` somewhere in the screen.
 */
export function useClockOnTarget(
  jobId: string,
  currentUserId: string
): {
  chooseClockOn: (
    myBookings: BookingWindow[] | null | undefined,
    scheduledCostCenterId: string | null | undefined,
    opts?: { force?: boolean }
  ) => Promise<ClockOnPick | undefined>;
  chooseSwitch: (open: { variation_id?: string | null; cost_center_id: string | null }) => Promise<ClockOnPick | undefined>;
  /** The job's variations (all statuses) as last read; null = not known. */
  variations: ClockVariation[] | null;
  sheet: ReactNode;
} {
  const stagesRef = useRef<ClockStage[] | null>(null);
  const [variations, setVariations] = useState<ClockVariation[] | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [picked, setPicked] = useState<Key | null>(null);
  const [newName, setNewName] = useState("");
  const [newDetails, setNewDetails] = useState("");
  const [newPhoto, setNewPhoto] = useState<string | null>(null);

  const readVariations = useCallback(async () => {
    const v = await listJobClockVariations(jobId);
    if (v) setVariations(v);
    return v;
  }, [jobId]);

  useEffect(() => {
    let live = true;
    void listJobClockStages(jobId).then((s) => {
      if (live && s) stagesRef.current = s;
    });
    void readVariations();
    return () => {
      live = false;
    };
  }, [jobId, readVariations]);

  const open = useCallback((p: Omit<Pending, "resolve">, preselect: Key | null) => {
    setPicked(preselect);
    setNewName("");
    setNewDetails("");
    setNewPhoto(null);
    return new Promise<ClockOnPick | undefined>((resolve) => setPending({ ...p, resolve }));
  }, []);

  const chooseClockOn = useCallback(
    async (myBookings: BookingWindow[] | null | undefined, scheduledCostCenterId: string | null | undefined, opts?: { force?: boolean }) => {
      // Fresh when possible (a stage may have been completed since the screen
      // opened), but never holding a clock-on up for long: at most 4 s, then
      // whatever is known (nothing known = the old rule).
      const [fresh, freshVariations] = await Promise.all([
        Promise.race([listJobClockStages(jobId), new Promise<null>((r) => setTimeout(() => r(null), 4000))]),
        Promise.race([readVariations(), new Promise<null>((r) => setTimeout(() => r(null), 2000))]),
      ]);
      if (fresh) stagesRef.current = fresh;
      const stages = stagesRef.current;
      const openVars = openClockVariations(freshVariations ?? variations);
      const choice = manualClockOnCostCentre(myBookings, Date.now(), scheduledCostCenterId, stages);
      if (choice.kind === "use" && openVars.length === 0 && !opts?.force) {
        return { costCenterId: choice.costCenterId, variationId: null, newVariation: null };
      }
      const stageOptions = choice.kind === "ask" ? (stages ?? []).filter((s) => choice.options.includes(s.id)) : [];
      const fallback = choice.kind === "use" ? choice.costCenterId : null;
      // Forced to a variation (or nothing to ask about the stage): nothing
      // preselected only when the stage itself is the open question.
      const preselect = choice.kind === "ask" || opts?.force ? null : `stage:${fallback ?? ""}`;
      return open({ mode: "clock-on", stageOptions, fallbackCostCenterId: fallback, variations: openVars, currentVariationId: null }, preselect);
    },
    [jobId, readVariations, variations, open]
  );

  const chooseSwitch = useCallback(
    async (current: { variation_id?: string | null; cost_center_id: string | null }) => {
      const fresh = await Promise.race([readVariations(), new Promise<null>((r) => setTimeout(() => r(null), 2000))]);
      const openVars = openClockVariations(fresh ?? variations).filter((v) => v.id !== (current.variation_id ?? null));
      return open(
        {
          mode: "switch",
          stageOptions: [],
          fallbackCostCenterId: current.cost_center_id,
          variations: openVars,
          currentVariationId: current.variation_id ?? null,
        },
        null
      );
    },
    [readVariations, variations, open]
  );

  const close = (value: ClockOnPick | undefined) => {
    pending?.resolve(value);
    setPending(null);
  };

  function confirm() {
    if (!pending || !picked) return;
    if (picked === "new") {
      if (!newName.trim()) {
        Alert.alert("Name the variation", "Say what it is — e.g. Hit rock.");
        return;
      }
      close({
        costCenterId: pending.fallbackCostCenterId,
        variationId: null,
        newVariation: {
          customName: newName.trim(),
          description: newDetails.trim() || null,
          loggedBy: currentUserId,
          photo: newPhoto ? { sourceUri: newPhoto, ext: "jpg" } : null,
        },
      });
      return;
    }
    if (picked.startsWith("var:")) {
      close({ costCenterId: pending.fallbackCostCenterId, variationId: picked.slice(4), newVariation: null });
      return;
    }
    const stageId = picked.slice("stage:".length) || null;
    close({ costCenterId: stageId ?? pending.fallbackCostCenterId, variationId: null, newVariation: null });
  }

  async function takePhoto() {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      Alert.alert("Permission needed", "Camera access is required");
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 1 });
    if (result.canceled || !result.assets?.length) return;
    setNewPhoto(await prepareImageForUpload(result.assets[0].uri));
  }

  const stageRows: { key: Key; label: string }[] = pending
    ? pending.stageOptions.length > 0
      ? pending.stageOptions.map((s) => ({ key: `stage:${s.id}`, label: startStageLabel(s) }))
      : pending.mode === "switch" && !pending.currentVariationId
        ? []
        : [
            {
              key: `stage:${pending.fallbackCostCenterId ?? ""}`,
              label: (() => {
                const s = (stagesRef.current ?? []).find((x) => x.id === pending.fallbackCostCenterId);
                return pending.mode === "switch" ? `Back to the stage${s ? ` — ${startStageLabel(s)}` : ""}` : s ? startStageLabel(s) : "Stage work";
              })(),
            },
          ]
    : [];

  const radio = (key: Key, label: string, icon?: keyof typeof Ionicons.glyphMap) => {
    const on = key === picked;
    return (
      <TouchableOpacity
        key={key}
        style={[styles.row, on && styles.rowOn]}
        onPress={() => setPicked(key)}
        accessibilityRole="radio"
        accessibilityState={{ selected: on }}
        accessibilityLabel={label}
      >
        <Ionicons name={icon ?? (on ? "radio-button-on" : "radio-button-off")} size={22} color={on ? colors.blue600 : colors.slate500} />
        <Text style={[styles.rowText, on && styles.rowTextOn]}>{label}</Text>
      </TouchableOpacity>
    );
  };

  const switching = pending?.mode === "switch";
  const sheet = (
    <KeyboardSheet
      visible={!!pending}
      onRequestClose={() => close(undefined)}
      title={switching ? "Switch what you're working on" : "Which are you working on?"}
      footer={
        <View style={styles.footer}>
          <TouchableOpacity style={[styles.btn, styles.btnPlain]} onPress={() => close(undefined)}>
            <Text style={styles.btnPlainText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btn, styles.btnMain, !picked && styles.btnOff]}
            disabled={!picked}
            onPress={confirm}
            accessibilityLabel={switching ? "Switch" : "Clock on"}
          >
            <Text style={styles.btnMainText}>{switching ? "Switch" : "Clock on"}</Text>
          </TouchableOpacity>
        </View>
      }
    >
      {pending && pending.stageOptions.length > 0 && (
        <Text style={styles.hint}>{"You're not booked on a cost centre right now. Pick the one you're doing — your hours go against it."}</Text>
      )}
      {stageRows.length > 0 && <View style={styles.list}>{stageRows.map((r) => radio(r.key, r.label))}</View>}
      <Text style={styles.section}>Extra work — a variation</Text>
      <Text style={styles.hint}>Hit rock or something not in the job? Time on a variation doesn&apos;t count toward the stage&apos;s hours.</Text>
      <View style={styles.list}>
        {(pending?.variations ?? []).map((v) => radio(`var:${v.id}`, `${v.name}${v.status === "pending_approval" ? " (waiting for the office)" : ""}`))}
        {radio("new", "+ New variation (e.g. hit rock)", "add-circle-outline")}
      </View>
      {picked === "new" && (
        <View style={styles.newForm}>
          <TextInput style={styles.input} value={newName} onChangeText={setNewName} placeholder="What is it? e.g. Hit rock" maxLength={120} />
          <TextInput
            style={[styles.input, styles.inputMulti]}
            value={newDetails}
            onChangeText={setNewDetails}
            placeholder="Details (where, how much, what you need to do)"
            multiline
          />
          <View style={styles.photoRow}>
            <TouchableOpacity style={styles.photoBtn} onPress={() => void takePhoto()} accessibilityLabel="Take a photo">
              <Ionicons name="camera-outline" size={18} color={colors.blue600} />
              <Text style={styles.photoBtnText}>{newPhoto ? "Retake photo" : "Take a photo"}</Text>
            </TouchableOpacity>
            {newPhoto && <Image source={{ uri: newPhoto }} style={styles.thumb} />}
          </View>
          <Text style={styles.hint}>The office prices and approves it, as from the Variations tab.</Text>
        </View>
      )}
    </KeyboardSheet>
  );

  return { chooseClockOn, chooseSwitch, variations, sheet };
}

const styles = StyleSheet.create({
  list: { gap: 8, marginTop: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, padding: 14, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: "#fff" },
  rowOn: { borderColor: colors.blue600, backgroundColor: "#eff6ff" },
  rowText: { flex: 1, fontSize: 16, color: colors.slate900 },
  rowTextOn: { fontWeight: "700", color: colors.blue600 },
  hint: { fontSize: 14, color: colors.slate500, marginTop: 4 },
  section: { fontSize: 15, fontWeight: "700", color: colors.slate900, marginTop: 16 },
  newForm: { gap: 8, marginTop: 8 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12, fontSize: 16, color: colors.slate900, backgroundColor: "#fff" },
  inputMulti: { minHeight: 70, textAlignVertical: "top" },
  photoRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  photoBtn: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10, backgroundColor: colors.slate100 },
  photoBtnText: { fontSize: 15, fontWeight: "600", color: colors.blue600 },
  thumb: { width: 48, height: 48, borderRadius: 6 },
  footer: { flexDirection: "row", gap: 10 },
  btn: { flex: 1, paddingVertical: 14, borderRadius: 10, alignItems: "center" },
  btnPlain: { backgroundColor: colors.slate100 },
  btnPlainText: { fontSize: 16, fontWeight: "700", color: colors.slate700 },
  btnMain: { backgroundColor: colors.blue600 },
  btnOff: { opacity: 0.4 },
  btnMainText: { fontSize: 16, fontWeight: "700", color: "#fff" },
});
