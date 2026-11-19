import { useCallback, useEffect, useState } from "react";
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, Alert, Modal, RefreshControl, FlatList } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { colors } from "../../lib/theme";
import { netInfoConnectivity } from "../../lib/data/net/connectivity";
import { openNavigation } from "../../lib/open-external-url";
import { formatWorkDate } from "../../lib/dayWorks";
import { loadSummary, newDraft, signProblem, type LoadBilling, type LoadDirection, type TruckLoad, type TruckLoadDraft } from "../../lib/truckLoads";
import {
  TODAYS_RUN_OFFLINE,
  draftExtras,
  formContextFor,
  isRunOffline,
  loadTodaysRun,
  slotText,
  totalsText,
  type RunJob,
  type RunOtherJob,
  type TodaysRunState,
} from "../../lib/todaysRun";
import { SignLoadsScreen, TruckLoadSheet, truckLoadStyles as styles } from "../job/truck-load-forms";
import { LOAD_STATUS_STYLE } from "../job/truck-loads";

// "Today's run" — the truck driver's run sheet (19 Nov 2026). Every job the
// signed-in user is carting for today (their own cartage bookings, decided by
// the server — lib/todaysRun.ts), in booking order, each with one-tap
// "+ Material in" / "+ Spoil out" (the same form as the job's Truck loads),
// the builder's sign-off for that job's extras, and today's loads so far.
// "+ Add a job" logs against another of their own open jobs. Online only.
// Quantities only — no money on this screen for anyone.

type Run = Extract<TodaysRunState, { ready: true }>;
type Status = { kind: "loading" } | { kind: "offline" } | { kind: "error"; message: string } | { kind: "not-ready" } | { kind: "ok"; run: Run };

/** The job the form is open for (a run job, or one picked with "+ Add a job"). */
type FormJob = { id: string; quarryIncluded: boolean | null; siteLabel: string | null };

export function TodaysRunScreen() {
  const router = useRouter();
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  const [form, setForm] = useState<{ job: FormJob; draft: TruckLoadDraft } | null>(null);
  const [signing, setSigning] = useState<{ job: RunJob; loads: TruckLoad[] } | null>(null);
  const [picking, setPicking] = useState(false);

  const load = useCallback(async () => {
    setStatus((s) => (s.kind === "ok" ? s : { kind: "loading" }));
    if (!(await netInfoConnectivity.isOnline().catch(() => true))) {
      setStatus({ kind: "offline" });
      return;
    }
    try {
      const res = await loadTodaysRun();
      setStatus(res.ready ? { kind: "ok", run: res } : { kind: "not-ready" });
    } catch (e) {
      if (isRunOffline(e)) setStatus({ kind: "offline" });
      else setStatus({ kind: "error", message: e instanceof Error ? e.message : "Couldn't load today's run." });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  if (status.kind === "loading") {
    return (
      <SafeAreaView style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.bg }} edges={["bottom"]}>
        <ActivityIndicator size="large" color={colors.blue600} />
      </SafeAreaView>
    );
  }
  if (status.kind !== "ok") {
    const message =
      status.kind === "offline" ? TODAYS_RUN_OFFLINE : status.kind === "not-ready" ? "Truck loads aren't switched on yet. Ask the office." : status.message;
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={["bottom"]}>
        <View style={styles.card}>
          <Text style={styles.heading}>{"Today's run"}</Text>
          <Text style={status.kind === "error" ? styles.error : styles.meta}>{message}</Text>
          {status.kind !== "not-ready" && (
            <TouchableOpacity style={styles.secondaryWide} onPress={() => void load()} accessibilityRole="button">
              <Text style={styles.secondaryText}>Try again</Text>
            </TouchableOpacity>
          )}
        </View>
      </SafeAreaView>
    );
  }

  const run = status.run;
  const start = (job: FormJob, defaults: Record<LoadDirection, LoadBilling>, direction: LoadDirection) =>
    setForm({ job, draft: newDraft(direction, run.date, defaults, run.trucks) });

  function startSign(job: RunJob) {
    const loads = draftExtras(job, run.date);
    const problem = signProblem(loads);
    if (problem) {
      Alert.alert("Not ready to sign", problem);
      return;
    }
    setSigning({ job, loads });
  }

  function pickOther(j: RunOtherJob) {
    setPicking(false);
    const job: FormJob = { id: j.id, quarryIncluded: j.quarryIncluded, siteLabel: j.siteLabel };
    Alert.alert(`#${j.jobNumber} — ${j.title}`, "What are you logging?", [
      { text: "Cancel", style: "cancel" },
      { text: "Material in", onPress: () => start(job, j.defaults, "material_in") },
      { text: "Spoil out", onPress: () => start(job, j.defaults, "spoil_out") },
    ]);
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }} edges={["bottom"]}>
      <ScrollView contentContainerStyle={{ paddingBottom: 32 }} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} />}>
        <Text style={styles.dateHeading}>{formatWorkDate(run.date)}</Text>
        {run.trucks.length === 0 && <Text style={[styles.warn, { marginHorizontal: 16, marginTop: 8 }]}>There are no trucks in the fleet register yet. Ask the office to add them.</Text>}
        {run.jobs.length === 0 && (
          <View style={styles.card}>
            <Text style={styles.meta}>{"You're not booked on any cartage today. Use \"+ Add a job\" to log a load on one of your jobs."}</Text>
          </View>
        )}

        {run.jobs.map((job) => {
          const extras = draftExtras(job, run.date);
          const inText = totalsText(job.totals.in);
          const outText = totalsText(job.totals.out);
          const formJob: FormJob = { id: job.id, quarryIncluded: job.quarryIncluded, siteLabel: job.siteLabel };
          return (
            <View key={job.id} style={styles.card}>
              <Text style={styles.title} numberOfLines={2}>
                #{job.jobNumber} — {job.title}
              </Text>
              {!!job.customer && <Text style={styles.meta}>{job.customer}</Text>}
              {!!job.siteLabel && <Text style={styles.body}>📍 {job.siteLabel}</Text>}
              {job.slots.map((s) => (
                <Text key={s.bookingId} style={styles.meta}>
                  🕐 {slotText(s)}
                </Text>
              ))}
              {!job.booked && <Text style={styles.meta}>Not booked for cartage today — added to your run.</Text>}

              <View style={styles.locked}>
                <Text style={styles.label}>Today so far</Text>
                {inText || outText ? (
                  <>
                    {!!inText && (
                      <Text style={styles.body}>
                        In: {inText}
                        {job.totals.in.materials.length > 0 ? ` (${job.totals.in.materials.join(", ")})` : ""}
                      </Text>
                    )}
                    {!!outText && <Text style={styles.body}>Out: {outText}</Text>}
                  </>
                ) : (
                  <Text style={styles.meta}>No loads yet.</Text>
                )}
                {job.loads
                  .filter((l) => l.status !== "void")
                  .map((l) => {
                    const st = LOAD_STATUS_STYLE[l.status] ?? LOAD_STATUS_STYLE.draft;
                    return (
                      <View key={l.id} style={styles.row}>
                        <Text style={styles.meta} numberOfLines={2}>
                          {l.direction === "material_in" ? "In" : "Out"} · {loadSummary(l, job.siteLabel)}
                          {l.billing === "extra" ? " · extra" : ""}
                        </Text>
                        <View style={[styles.pill, { backgroundColor: st.bg }]}>
                          <Text style={[styles.pillText, { color: st.text }]}>{st.label}</Text>
                        </View>
                      </View>
                    );
                  })}
              </View>

              {run.trucks.length > 0 && (
                <View style={styles.actions}>
                  <TouchableOpacity style={styles.primaryHalf} onPress={() => start(formJob, job.defaults, "material_in")} accessibilityRole="button" accessibilityLabel={`Add material in on job ${job.jobNumber}`}>
                    <Text style={styles.primaryText}>+ Material in</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.primaryHalf} onPress={() => start(formJob, job.defaults, "spoil_out")} accessibilityRole="button" accessibilityLabel={`Add spoil out on job ${job.jobNumber}`}>
                    <Text style={styles.primaryText}>+ Spoil out</Text>
                  </TouchableOpacity>
                </View>
              )}
              {extras.length > 0 && (
                <TouchableOpacity style={[styles.primary, { backgroundColor: colors.orange700 }]} onPress={() => startSign(job)} accessibilityRole="button">
                  <Text style={styles.primaryText}>Get builder to sign ({extras.length} extra{extras.length === 1 ? "" : "s"})</Text>
                </TouchableOpacity>
              )}
              <View style={styles.actions}>
                {!!job.site && (
                  <TouchableOpacity style={styles.secondary} onPress={() => void openNavigation(job.site)} accessibilityRole="button">
                    <Text style={styles.secondaryText}>Navigate</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity style={styles.secondary} onPress={() => router.push(`/job/${job.id}`)} accessibilityRole="button">
                  <Text style={styles.secondaryText}>Open job</Text>
                </TouchableOpacity>
              </View>
            </View>
          );
        })}

        <TouchableOpacity style={[styles.secondaryWide, { marginHorizontal: 16, marginTop: 12 }]} onPress={() => setPicking(true)} accessibilityRole="button">
          <Text style={styles.secondaryText}>+ Add a job</Text>
        </TouchableOpacity>

        <View style={styles.card}>
          <Text style={styles.heading}>Day totals</Text>
          <Text style={styles.body}>Material in: {totalsText(run.totals.in) || "none yet"}</Text>
          <Text style={styles.body}>Spoil out: {totalsText(run.totals.out) || "none yet"}</Text>
          <Text style={styles.bodyStrong}>{totalsText(run.totals) || "No loads logged today."}</Text>
        </View>
      </ScrollView>

      {form && (
        <TruckLoadSheet
          jobId={form.job.id}
          draft={form.draft}
          setDraft={(d) => setForm((f) => (f ? { ...f, draft: d } : f))}
          form={formContextFor(run, form.job)}
          onSaved={() => void load()}
          onClose={() => setForm(null)}
        />
      )}

      {signing && (
        <SignLoadsScreen
          jobId={signing.job.id}
          date={run.date}
          loads={signing.loads}
          siteLabel={signing.job.siteLabel}
          onCancel={() => setSigning(null)}
          onSigned={() => {
            setSigning(null);
            void load();
            Alert.alert("Signed off", "These loads are now locked.");
          }}
        />
      )}

      <Modal visible={picking} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setPicking(false)}>
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
          <View style={[styles.row, { padding: 16 }]}>
            <Text style={styles.title}>Add a job to your run</Text>
            <TouchableOpacity onPress={() => setPicking(false)} accessibilityRole="button">
              <Text style={styles.secondaryText}>Close</Text>
            </TouchableOpacity>
          </View>
          <FlatList
            data={run.otherJobs}
            keyExtractor={(j) => j.id}
            ListEmptyComponent={<Text style={[styles.meta, { textAlign: "center", marginTop: 24 }]}>No other open jobs of yours.</Text>}
            renderItem={({ item }) => (
              <TouchableOpacity style={styles.card} onPress={() => pickOther(item)} accessibilityRole="button">
                <Text style={styles.bodyStrong}>
                  #{item.jobNumber} — {item.title}
                </Text>
                {!!item.customer && <Text style={styles.meta}>{item.customer}</Text>}
                {!!item.siteLabel && <Text style={styles.meta}>📍 {item.siteLabel}</Text>}
              </TouchableOpacity>
            )}
          />
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}
