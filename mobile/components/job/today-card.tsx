import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, Alert } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { getOpenWorkEntryOnJob } from "../../lib/data/reads/clock";
import { useTimeClock } from "../../lib/data/hooks/useTimeClock";
import { onClockChanged } from "../../lib/clockEvents";
import { clockInCostCentre, type BookingWindow } from "../../lib/bookings";
import { loadSupplierOrders } from "../../lib/supplierOrders";
import { todaySteps, type StepKey, type TodayStep } from "../../lib/todaySteps";

// The Today card at the top of a job (Stage 6, 31 Oct 2026): the day's steps
// in order, each ticked from what's already recorded (lib/todaySteps.ts), with
// one big button per step — the crew are outdoors, often in gloves. Clock on
// happens right here; every other step jumps to the tab that does it.

type Tab = "time" | "orders" | "photos" | "notes" | "signature";

const STEP_TAB: Record<StepKey, Tab | null> = {
  clock: null,
  materials: "orders",
  deliveries: "orders",
  progress: "photos",
  finish: "signature",
};

const BUTTON: Record<StepKey, string> = {
  clock: "Clock on",
  materials: "Order",
  deliveries: "Orders",
  progress: "Add photo",
  finish: "Sign off",
};

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit" });
}

export function JobTodayCard({
  jobId,
  currentUserId,
  signedOff,
  scheduledCostCenterId,
  myBookings,
  onGo,
}: {
  jobId: string;
  currentUserId: string;
  signedOff: boolean;
  scheduledCostCenterId: string | null;
  myBookings: BookingWindow[] | null;
  onGo: (tab: Tab) => void;
}) {
  const timeClock = useTimeClock();
  const [clockedInSince, setClockedInSince] = useState<string | null>(null);
  const [orders, setOrders] = useState<{ status: string; deliveredAt?: string | null }[] | null>(null);
  const [clocking, setClocking] = useState(false);

  const refresh = useCallback(async () => {
    const open = await getOpenWorkEntryOnJob(currentUserId, jobId).catch(() => null);
    setClockedInSince(open?.clockInIso ?? null);
    // Online only, like the Orders tab; offline the step says so.
    loadSupplierOrders(jobId)
      .then((s) => setOrders(s.orders))
      .catch(() => setOrders(null));
  }, [currentUserId, jobId]);

  useEffect(() => {
    void refresh();
    return onClockChanged(() => void refresh());
  }, [refresh]);

  async function clockOn() {
    if (clocking || !timeClock.ready) return;
    setClocking(true);
    try {
      // The same default cost centre as the Time tab: the booking covering now,
      // then the nearest one today, then the job's.
      await timeClock.clockIn({ jobId, staffId: currentUserId, costCenterId: clockInCostCentre(myBookings, Date.now(), scheduledCostCenterId) });
      setClockedInSince(new Date().toISOString());
    } catch (e: any) {
      Alert.alert("Clock on failed", e?.message ?? "Try again from the Time tab.");
    } finally {
      setClocking(false);
    }
  }

  const steps = todaySteps({ clockedInSince, orders, signedOff, formatTime });

  function press(step: TodayStep) {
    if (step.key === "clock") void clockOn();
    else {
      const tab = STEP_TAB[step.key];
      if (tab) onGo(tab);
    }
  }

  return (
    <View style={styles.card}>
      <Text style={styles.heading}>Today</Text>
      {steps.map((step, n) => {
        const done = step.state === "done";
        const next = step.state === "next";
        // A done clock-on has nothing to press; a done step elsewhere still opens its tab.
        const showButton = !(step.key === "clock" && done) && !(step.key === "finish" && done);
        return (
          <View key={step.key} style={[styles.row, next && styles.rowNext]}>
            <View style={[styles.badge, done ? styles.badgeDone : next ? styles.badgeNext : styles.badgeTodo]}>
              {done ? (
                <Ionicons name="checkmark" size={18} color="#fff" />
              ) : (
                <Text style={[styles.badgeText, next && { color: "#fff" }]}>{n + 1}</Text>
              )}
            </View>
            <View style={styles.text}>
              <Text style={[styles.title, done && styles.titleDone]}>{step.title}</Text>
              <Text style={styles.detail}>{step.detail}</Text>
            </View>
            {showButton && (
              <TouchableOpacity
                style={[styles.button, next ? styles.buttonNext : styles.buttonPlain]}
                onPress={() => press(step)}
                disabled={step.key === "clock" && clocking}
                accessibilityLabel={BUTTON[step.key]}
              >
                <Text style={[styles.buttonText, next && { color: "#fff" }]}>
                  {step.key === "clock" && clocking ? "…" : BUTTON[step.key]}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { margin: 16, marginBottom: 0, padding: 12, borderRadius: 12, backgroundColor: "#fff", borderWidth: 1, borderColor: colors.border, gap: 6 },
  heading: { fontSize: 13, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, paddingHorizontal: 6, borderRadius: 8 },
  rowNext: { backgroundColor: "#eff6ff" },
  badge: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  badgeDone: { backgroundColor: colors.green600 },
  badgeNext: { backgroundColor: colors.blue600 },
  badgeTodo: { backgroundColor: colors.slate100 },
  badgeText: { fontSize: 14, fontWeight: "700", color: colors.slate500 },
  text: { flex: 1 },
  title: { fontSize: 16, fontWeight: "700", color: colors.slate900 },
  titleDone: { color: colors.slate500 },
  detail: { fontSize: 12, color: colors.slate500, marginTop: 1 },
  button: { minWidth: 92, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 10, alignItems: "center" },
  buttonNext: { backgroundColor: colors.blue600 },
  buttonPlain: { backgroundColor: colors.slate100 },
  buttonText: { fontSize: 15, fontWeight: "700", color: colors.slate700 },
});
