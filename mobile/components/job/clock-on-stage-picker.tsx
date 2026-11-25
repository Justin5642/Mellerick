import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { KeyboardSheet } from "../KeyboardSheet";
import { manualClockOnCostCentre, type BookingWindow } from "../../lib/bookings";
import { listJobClockStages, type ClockStage } from "../../lib/data/reads/clockStages";
import { startStageLabel } from "../../lib/selfStartBooking";

// The cost centre of a MANUAL clock-on (Time tab, Today card) — Justin, 25 Nov
// 2026: "it is critical that they clock on to the correct cost centre". Their
// booking's stage when they have one; with no booking and two or more open
// stages it ASKS instead of guessing; completed stages are never used or
// offered (lib/bookings.ts manualClockOnCostCentre). The stage list is online
// (GET /api/jobs/[id]/stages); offline it behaves as before.

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

type Pending = { options: ClockStage[]; resolve: (picked: string | null | undefined) => void };

/**
 * `chooseCostCentre(myBookings, scheduledCostCenterId)` resolves to the cost
 * centre to clock on with (null = none), or `undefined` when they cancelled
 * the picker. Render `sheet` somewhere in the screen.
 */
export function useClockOnCostCentre(jobId: string): {
  chooseCostCentre: (myBookings: BookingWindow[] | null | undefined, scheduledCostCenterId: string | null | undefined) => Promise<string | null | undefined>;
  sheet: ReactNode;
} {
  const stagesRef = useRef<ClockStage[] | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void listJobClockStages(jobId).then((s) => {
      if (live && s) stagesRef.current = s;
    });
    return () => {
      live = false;
    };
  }, [jobId]);

  const chooseCostCentre = useCallback(
    async (myBookings: BookingWindow[] | null | undefined, scheduledCostCenterId: string | null | undefined) => {
      // Fresh when possible (a stage may have been completed since the screen
      // opened), but never holding a clock-on up for long: at most 4 s, then
      // whatever is known (nothing known = the old rule).
      const fresh = await Promise.race([
        listJobClockStages(jobId),
        new Promise<null>((r) => setTimeout(() => r(null), 4000)),
      ]);
      if (fresh) stagesRef.current = fresh;
      const stages = stagesRef.current;
      const choice = manualClockOnCostCentre(myBookings, Date.now(), scheduledCostCenterId, stages);
      if (choice.kind === "use") return choice.costCenterId;
      const options = (stages ?? []).filter((s) => choice.options.includes(s.id));
      setPicked(null);
      return new Promise<string | null | undefined>((resolve) => setPending({ options, resolve }));
    },
    [jobId]
  );

  const close = (value: string | null | undefined) => {
    pending?.resolve(value);
    setPending(null);
  };

  const sheet = (
    <KeyboardSheet
      visible={!!pending}
      onRequestClose={() => close(undefined)}
      title="Which cost centre are you working on?"
      footer={
        <View style={styles.footer}>
          <TouchableOpacity style={[styles.btn, styles.btnPlain]} onPress={() => close(undefined)}>
            <Text style={styles.btnPlainText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.btn, styles.btnMain, !picked && styles.btnOff]}
            disabled={!picked}
            onPress={() => close(picked)}
            accessibilityLabel="Clock on"
          >
            <Text style={styles.btnMainText}>Clock on</Text>
          </TouchableOpacity>
        </View>
      }
    >
      <Text style={styles.hint}>{"You're not booked on a cost centre right now. Pick the one you're doing — your hours go against it."}</Text>
      <StageList stages={pending?.options ?? []} selectedId={picked} onSelect={setPicked} />
    </KeyboardSheet>
  );

  return { chooseCostCentre, sheet };
}

const styles = StyleSheet.create({
  list: { gap: 8, marginTop: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, padding: 14, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: "#fff" },
  rowOn: { borderColor: colors.blue600, backgroundColor: "#eff6ff" },
  rowText: { flex: 1, fontSize: 16, color: colors.slate900 },
  rowTextOn: { fontWeight: "700", color: colors.blue600 },
  hint: { fontSize: 14, color: colors.slate500 },
  footer: { flexDirection: "row", gap: 10 },
  btn: { flex: 1, paddingVertical: 14, borderRadius: 10, alignItems: "center" },
  btnPlain: { backgroundColor: colors.slate100 },
  btnPlainText: { fontSize: 16, fontWeight: "700", color: colors.slate700 },
  btnMain: { backgroundColor: colors.blue600 },
  btnOff: { opacity: 0.4 },
  btnMainText: { fontSize: 16, fontWeight: "700", color: "#fff" },
});
