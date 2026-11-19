import { useCallback, useEffect, useState } from "react";
import { View, Text, TouchableOpacity, ActivityIndicator, Alert, Image } from "react-native";
import { colors } from "../../lib/theme";
import { localDateKey } from "../../lib/date";
import { netInfoConnectivity } from "../../lib/data/net/connectivity";
import { MoneyText } from "../../design/components/MoneyText";
import { RoleGate } from "../../design/guards/RoleGate";
import { formatWorkDate } from "../../lib/dayWorks";
import {
  TRUCK_LOADS_OFFLINE,
  deleteTruckLoad,
  draftFromLoad,
  extrasToSign,
  groupLoadsByDate,
  isTruckLoadsOffline,
  loadSummary,
  loadTruckLoads,
  newDraft,
  setQuarryDefault,
  signProblem,
  voidTruckLoad,
  type LoadDirection,
  type TruckLoad,
  type TruckLoadDraft,
  type TruckLoadsState,
} from "../../lib/truckLoads";
import { SignLoadsScreen, TruckLoadSheet, takePhoto, truckLoadStyles as styles, uploadDocketPhoto } from "./truck-load-forms";
import { LoadOfficePanel, QuarryDefaultPicker, VoidReasonSheet } from "./day-works-office";

// Truck loads on the phone (migration 0111, drafted — not applied yet), in the
// job's Day Works tab. The driver logs each trip as it happens: "+ Material in"
// (quarry product from a quarry to the job) or "+ Spoil out" (dirt carted from
// the job to a tip), with the docket number and a photo of the docket. Each
// load is INCLUDED (in the quoted price) or EXTRA (charged to the builder) —
// spoil defaults to extra, quarry product to the job's setting — and the
// builder's rep signs the day's extras on the glass, once, after which they
// lock.
//
// The form and the sign-off live in ./truck-load-forms.tsx, shared with the
// driver's run sheet ("Today's run").
//
// Online only (lib/truckLoads.ts says why). Quantities only for the crew: the
// server sends a technician no rate, cost or price, and never the docket photo
// back (it shows prices). Office amounts render only through MoneyText inside
// a RoleGate. Office/admin also get the web tab's own controls here
// (./day-works-office.tsx): the job's quarry default, each load's docket cost
// + margin and price breakdown, the docket photo, and Void on a signed load.

export type TruckLoadsLoaded = Extract<TruckLoadsState, { ready: true }>;
type Loaded = TruckLoadsLoaded;
type Status = { kind: "loading" } | { kind: "offline" } | { kind: "error"; message: string } | { kind: "not-ready" } | { kind: "ok"; view: Loaded };

export const LOAD_STATUS_STYLE: Record<string, { bg: string; text: string; label: string }> = {
  draft: { bg: colors.slate100, text: colors.slate700, label: "Draft" },
  signed: { bg: colors.green100, text: colors.green600, label: "Signed" },
  invoiced: { bg: colors.blue100, text: colors.blue600, label: "Invoiced" },
  void: { bg: colors.red100, text: colors.red600, label: "Void" },
};

export function TruckLoadsSection({ jobId, onLoaded, reloadKey = 0 }: {
  jobId: string;
  /** The Day Works tab's Invoice Day Works needs the signed extras and their prices (office). */
  onLoaded?: (view: TruckLoadsLoaded | null) => void;
  /** Bump to reload (after an invoice is made). */
  reloadKey?: number;
}) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [voiding, setVoiding] = useState<TruckLoad | null>(null);
  const [draft, setDraft] = useState<TruckLoadDraft | null>(null);
  const [signing, setSigning] = useState<{ date: string; loads: TruckLoad[] } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const show = useCallback(
    (res: TruckLoadsState) => {
      setStatus(res.ready ? { kind: "ok", view: res } : { kind: "not-ready" });
      onLoaded?.(res.ready ? res : null);
    },
    [onLoaded]
  );

  const load = useCallback(async () => {
    setStatus((s) => (s.kind === "ok" ? s : { kind: "loading" }));
    if (!(await netInfoConnectivity.isOnline().catch(() => true))) {
      setStatus({ kind: "offline" });
      return;
    }
    try {
      show(await loadTruckLoads(jobId));
    } catch (e) {
      if (isTruckLoadsOffline(e)) setStatus({ kind: "offline" });
      else setStatus({ kind: "error", message: e instanceof Error ? e.message : "Couldn't load the truck loads." });
    }
  }, [jobId, show]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  async function changeQuarry(next: boolean | null) {
    try {
      show(await setQuarryDefault(jobId, next));
    } catch (e) {
      Alert.alert("Not changed", e instanceof Error ? e.message : "Try again.");
    }
  }

  async function addPhotoTo(l: TruckLoad) {
    const uri = await takePhoto();
    if (!uri) return;
    setBusyId(l.id);
    try {
      show(await uploadDocketPhoto(jobId, l.id, uri));
    } catch (e) {
      Alert.alert("Docket photo not saved", e instanceof Error ? e.message : "Try again.");
    } finally {
      setBusyId(null);
    }
  }

  function confirmDelete(l: TruckLoad) {
    Alert.alert("Delete this load?", `${loadSummary(l, null)} on ${formatWorkDate(l.load_date)}.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setBusyId(l.id);
          try {
            show(await deleteTruckLoad(jobId, l.id));
          } catch (err) {
            Alert.alert("Not deleted", err instanceof Error ? err.message : "Try again.");
          } finally {
            setBusyId(null);
          }
        },
      },
    ]);
  }

  function startSign(date: string, loads: TruckLoad[]) {
    const problem = signProblem(loads);
    if (problem) {
      Alert.alert("Not ready to sign", problem);
      return;
    }
    setSigning({ date, loads });
  }

  if (status.kind === "loading") return <ActivityIndicator style={{ marginTop: 16 }} color={colors.blue600} />;
  if (status.kind === "offline" || status.kind === "error") {
    return (
      <View style={styles.card}>
        <Text style={styles.heading}>Truck loads</Text>
        <Text style={status.kind === "offline" ? styles.meta : styles.error}>{status.kind === "offline" ? TRUCK_LOADS_OFFLINE : status.message}</Text>
        <TouchableOpacity style={styles.secondaryWide} onPress={() => void load()} accessibilityRole="button">
          <Text style={styles.secondaryText}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (status.kind === "not-ready") {
    return (
      <View style={styles.card}>
        <Text style={styles.heading}>Truck loads</Text>
        <Text style={styles.meta}>{"Truck loads aren't switched on yet. Ask the office."}</Text>
      </View>
    );
  }

  const view = status.view;
  const groups = groupLoadsByDate(view.loads);
  const today = localDateKey(new Date());
  const start = (direction: LoadDirection) => setDraft(newDraft(direction, today, view.defaults, view.trucks));

  return (
    <View style={{ paddingBottom: 8 }}>
      <View style={styles.card}>
        <Text style={styles.heading}>Truck loads</Text>
        <Text style={styles.meta}>{"Log each trip as it happens, with the docket. Extras are signed by the builder's rep."}</Text>
        {view.isOffice && <QuarryDefaultPicker value={view.quarryIncluded} onChange={(next) => void changeQuarry(next)} />}
        {view.trucks.length === 0 ? (
          <Text style={styles.warn}>There are no trucks in the fleet register yet. Ask the office to add them.</Text>
        ) : (
          <View style={styles.actions}>
            <TouchableOpacity style={styles.primaryHalf} onPress={() => start("material_in")} accessibilityRole="button" accessibilityLabel="Add material in">
              <Text style={styles.primaryText}>+ Material in</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.primaryHalf} onPress={() => start("spoil_out")} accessibilityRole="button" accessibilityLabel="Add spoil out">
              <Text style={styles.primaryText}>+ Spoil out</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {view.isOffice && view.pricing && view.pricing.uninvoicedSigned > 0 && (
        <RoleGate roles={["office", "admin"]}>
          <View style={[styles.card, styles.row]}>
            <Text style={styles.meta}>Signed extras, not yet invoiced (ex GST)</Text>
            <MoneyText amount={view.pricing.uninvoicedSigned} style={styles.bodyStrong} />
          </View>
        </RoleGate>
      )}

      {groups.length === 0 ? (
        <Text style={[styles.meta, { textAlign: "center", marginTop: 8 }]}>No truck loads on this job yet.</Text>
      ) : (
        groups.map((g) => {
          const toSign = extrasToSign(g.loads, g.date);
          return (
            <View key={g.date}>
              <Text style={styles.dateHeading}>{formatWorkDate(g.date)} · loads</Text>
              {g.loads.map((l) => {
                const st = LOAD_STATUS_STYLE[l.status] ?? LOAD_STATUS_STYLE.draft;
                const price = view.pricing?.loads[l.id];
                return (
                  <View key={l.id} style={[styles.card, l.status === "void" && { opacity: 0.6 }]}>
                    <View style={styles.row}>
                      <Text style={styles.title} numberOfLines={2}>
                        {l.direction === "material_in" ? "Material in" : "Spoil out"} <Text style={styles.meta}>· {l.truck}</Text>
                      </Text>
                      <View style={[styles.pill, { backgroundColor: st.bg }]}>
                        <Text style={[styles.pillText, { color: st.text }]}>{st.label}</Text>
                      </View>
                    </View>
                    <Text style={styles.qty}>{loadSummary(l, view.siteLabel)}</Text>
                    <View style={styles.row}>
                      <View style={[styles.pill, { backgroundColor: l.billing === "extra" ? colors.orange100 : colors.slate100 }]}>
                        <Text style={[styles.pillText, { color: l.billing === "extra" ? colors.orange700 : colors.slate700 }]}>
                          {l.billing === "extra" ? "Extra — charged" : "Included in quote"}
                        </Text>
                      </View>
                      <Text style={styles.meta}>{l.has_docket_photo ? "📷 Docket photo attached" : "No docket photo"}</Text>
                    </View>
                    {view.isOffice && price && l.billing === "extra" && (
                      <RoleGate roles={["office", "admin"]}>
                        {price.total === null ? <Text style={styles.warn}>Not priced</Text> : <MoneyText amount={price.total} style={styles.bodyStrong} />}
                      </RoleGate>
                    )}
                    {view.isOffice && view.pricing && <LoadOfficePanel jobId={jobId} load={l} pricing={view.pricing} onSaved={show} />}
                    {l.status !== "draft" && !!l.signer_name && (
                      <View style={styles.locked}>
                        <Text style={styles.lockedText}>
                          🔒 Signed by {l.signer_name}
                          {l.signed_at ? ` on ${new Date(l.signed_at).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })}` : ""}. Locked.
                        </Text>
                        {!!l.signature_url && <Image source={{ uri: l.signature_url }} style={styles.signatureImg} resizeMode="contain" accessibilityLabel={`Signature of ${l.signer_name}`} />}
                      </View>
                    )}
                    {l.status === "void" && !!l.void_reason && <Text style={styles.error}>Void: {l.void_reason}</Text>}
                    {view.isOffice && l.status === "signed" && (
                      <RoleGate roles={["office", "admin"]}>
                        <TouchableOpacity style={styles.secondaryWide} onPress={() => setVoiding(l)} accessibilityRole="button">
                          <Text style={[styles.secondaryText, { color: colors.red600 }]}>Void</Text>
                        </TouchableOpacity>
                      </RoleGate>
                    )}
                    {l.status === "draft" && (
                      <View style={styles.actions}>
                        {!l.has_docket_photo && (
                          <TouchableOpacity style={styles.secondary} onPress={() => void addPhotoTo(l)} disabled={busyId === l.id} accessibilityRole="button">
                            <Text style={styles.secondaryText}>{busyId === l.id ? "Saving…" : "Add docket photo"}</Text>
                          </TouchableOpacity>
                        )}
                        <TouchableOpacity style={styles.secondary} onPress={() => setDraft(draftFromLoad(l))} accessibilityRole="button">
                          <Text style={styles.secondaryText}>Edit</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.secondary} onPress={() => confirmDelete(l)} disabled={busyId === l.id} accessibilityRole="button">
                          <Text style={[styles.secondaryText, { color: colors.red600 }]}>Delete</Text>
                        </TouchableOpacity>
                      </View>
                    )}
                  </View>
                );
              })}
              {toSign.length > 0 && (
                <TouchableOpacity style={[styles.primary, { marginHorizontal: 16, marginTop: 10 }]} onPress={() => startSign(g.date, toSign)} accessibilityRole="button" accessibilityLabel="Get builder to sign the extras">
                  <Text style={styles.primaryText}>Get builder to sign ({toSign.length} extra{toSign.length === 1 ? "" : "s"})</Text>
                </TouchableOpacity>
              )}
            </View>
          );
        })
      )}

      {draft && <TruckLoadSheet jobId={jobId} draft={draft} setDraft={setDraft} form={view} onSaved={show} onClose={() => setDraft(null)} />}

      {voiding && (
        <VoidReasonSheet
          title="Void this load?"
          detail={`${formatWorkDate(voiding.load_date)} · ${voiding.truck} · ${loadSummary(voiding, view.siteLabel)}`}
          onVoid={async (reason) => show(await voidTruckLoad(jobId, voiding.id, reason))}
          onClose={() => setVoiding(null)}
        />
      )}

      {signing && (
        <SignLoadsScreen
          jobId={jobId}
          date={signing.date}
          loads={signing.loads}
          siteLabel={view.siteLabel}
          onCancel={() => setSigning(null)}
          onSigned={(res) => {
            setSigning(null);
            show(res);
            Alert.alert("Signed off", "These loads are now locked.");
          }}
        />
      )}
    </View>
  );
}
