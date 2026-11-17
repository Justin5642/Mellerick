import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TextInput, TouchableOpacity, ActivityIndicator, Alert, Modal, Platform, Image, KeyboardAvoidingView, Keyboard } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import DateTimePicker, { type DateTimePickerEvent } from "@react-native-community/datetimepicker";
import Signature, { type SignatureViewRef } from "react-native-signature-canvas";
import * as ImagePicker from "expo-image-picker";
import { colors } from "../../lib/theme";
import { localDateKey } from "../../lib/date";
import { cryptoIdGen } from "../../lib/data/ids";
import { netInfoConnectivity } from "../../lib/data/net/connectivity";
import { prepareImage } from "../../lib/imageUpload";
import { KeyboardSheet, KEYBOARD_SHEET_INPUT_FONT_SIZE } from "../KeyboardSheet";
import { MoneyText } from "../../design/components/MoneyText";
import { RoleGate } from "../../design/guards/RoleGate";
import { signatureWebStyle } from "./signature";
import { SupplierPickerSheet } from "./supplier-picker";
import { formatWorkDate } from "../../lib/dayWorks";
import {
  TRUCK_LOADS_OFFLINE,
  UNIT_LABEL,
  addTruckLoad,
  attachDocketPhoto,
  deleteTruckLoad,
  draftFromLoad,
  extrasToSign,
  groupLoadsByDate,
  isTruckLoadsOffline,
  loadInputFromDraft,
  loadSummary,
  loadTruckLoads,
  newDraft,
  signProblem,
  signTruckLoads,
  updateTruckLoad,
  type LoadDirection,
  type LoadUnit,
  type TruckLoad,
  type TruckLoadDraft,
  type TruckLoadsState,
} from "../../lib/truckLoads";

// Truck loads on the phone (migration 0111, drafted — not applied yet), in the
// job's Day Works tab. The driver logs each trip as it happens: "+ Material in"
// (quarry product from a quarry to the job) or "+ Spoil out" (dirt carted from
// the job to a tip), with the docket number and a photo of the docket. Each
// load is INCLUDED (in the quoted price) or EXTRA (charged to the builder) —
// spoil defaults to extra, quarry product to the job's setting — and the
// builder's rep signs the day's extras on the glass, once, after which they
// lock.
//
// Online only (lib/truckLoads.ts says why). Quantities only for the crew: the
// server sends a technician no rate, cost or price, and never the docket photo
// back (it shows prices). Office amounts render only through MoneyText inside
// a RoleGate.

type Loaded = Extract<TruckLoadsState, { ready: true }>;
type Status = { kind: "loading" } | { kind: "offline" } | { kind: "error"; message: string } | { kind: "not-ready" } | { kind: "ok"; view: Loaded };

const STATUS_STYLE: Record<string, { bg: string; text: string; label: string }> = {
  draft: { bg: colors.slate100, text: colors.slate700, label: "Draft" },
  signed: { bg: colors.green100, text: colors.green600, label: "Signed" },
  invoiced: { bg: colors.blue100, text: colors.blue600, label: "Invoiced" },
  void: { bg: colors.red100, text: colors.red600, label: "Void" },
};

export function TruckLoadsSection({ jobId }: { jobId: string }) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [draft, setDraft] = useState<TruckLoadDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [signing, setSigning] = useState<{ date: string; loads: TruckLoad[] } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // A new load's id, made before the first Save and kept across retries, so a
  // retry after a dropped answer can't log the trip twice.
  const newLoadId = useRef(cryptoIdGen.newId());

  const show = useCallback((res: TruckLoadsState) => {
    setStatus(res.ready ? { kind: "ok", view: res } : { kind: "not-ready" });
  }, []);

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
  }, [load]);

  async function uploadDocket(loadId: string, uri: string) {
    const { base64 } = await prepareImage(uri, { base64: true });
    if (!base64) throw new Error("Couldn't prepare the photo — take it again.");
    show(await attachDocketPhoto(jobId, loadId, base64));
  }

  async function save() {
    if (!draft || saving || status.kind !== "ok") return;
    const built = loadInputFromDraft(draft);
    if (!built.ok) {
      Alert.alert("Check the load", built.error);
      return;
    }
    setSaving(true);
    const loadId = draft.id ?? newLoadId.current;
    try {
      const res = draft.id ? await updateTruckLoad(jobId, draft.id, built.input) : await addTruckLoad(jobId, { ...built.input, id: loadId });
      if (!draft.id) newLoadId.current = cryptoIdGen.newId();
      show(res);
      const photo = draft.photoUri;
      setDraft(null);
      if (photo) {
        try {
          await uploadDocket(loadId, photo);
        } catch (e) {
          Alert.alert("Load saved, docket photo not", `${e instanceof Error ? e.message : "Try again."} Use "Add docket photo" on the load.`);
        }
      }
    } catch (e) {
      Alert.alert("Not saved", e instanceof Error ? e.message : "Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function addPhotoTo(l: TruckLoad) {
    const uri = await takePhoto();
    if (!uri) return;
    setBusyId(l.id);
    try {
      await uploadDocket(l.id, uri);
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
                const st = STATUS_STYLE[l.status] ?? STATUS_STYLE.draft;
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
                        {price.total === null ? <Text style={styles.warn}>{price.problem ?? "Not priced"}</Text> : <MoneyText amount={price.total} style={styles.bodyStrong} />}
                      </RoleGate>
                    )}
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

      {draft && <LoadSheet draft={draft} setDraft={setDraft} view={view} saving={saving} onSave={() => void save()} onCancel={() => setDraft(null)} />}

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

async function takePhoto(): Promise<string | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) {
    Alert.alert("Camera needed", "Allow camera access to photograph the docket.");
    return null;
  }
  const shot = await ImagePicker.launchCameraAsync({ quality: 1 });
  if (shot.canceled || !shot.assets?.length) return null;
  return shot.assets[0].uri;
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={[styles.chip, active && styles.chipActive]} onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: active }}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function Field({ label, value, onChange, numeric, placeholder }: { label: string; value: string; onChange: (v: string) => void; numeric?: boolean; placeholder?: string }) {
  return (
    <View style={{ flex: 1, gap: 4 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChange}
        keyboardType={numeric ? "decimal-pad" : "default"}
        placeholder={placeholder}
        placeholderTextColor={colors.slate400}
        accessibilityLabel={label}
      />
    </View>
  );
}

function LoadSheet({ draft, setDraft, view, saving, onSave, onCancel }: {
  draft: TruckLoadDraft;
  setDraft: (d: TruckLoadDraft) => void;
  view: Loaded;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const [showDate, setShowDate] = useState(false);
  const [pickQuarry, setPickQuarry] = useState(false);
  const set = (patch: Partial<TruckLoadDraft>) => setDraft({ ...draft, ...patch });
  const today = localDateKey(new Date());
  const yesterday = localDateKey(new Date(Date.now() - 86_400_000));
  const isSpoil = draft.direction === "spoil_out";
  const quarry = view.suppliers.find((s) => s.id === draft.supplier_id);

  function onDateChange(event: DateTimePickerEvent, selected?: Date) {
    setShowDate(Platform.OS === "ios");
    if (event.type === "set" && selected) set({ load_date: localDateKey(selected) });
  }

  async function photo() {
    const uri = await takePhoto();
    if (uri) set({ photoUri: uri });
  }

  return (
    <KeyboardSheet
      visible
      onRequestClose={onCancel}
      title={`${draft.id ? "Edit" : "Add"} ${isSpoil ? "spoil out" : "material in"}`}
      footer={
        <View style={styles.actions}>
          <TouchableOpacity style={styles.cancel} onPress={onCancel} accessibilityRole="button">
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.save} onPress={onSave} disabled={saving} accessibilityRole="button">
            <Text style={styles.saveText}>{saving ? "Saving…" : "Save"}</Text>
          </TouchableOpacity>
        </View>
      }
    >
      <View style={{ gap: 12 }}>
        <View style={{ gap: 6 }}>
          <Text style={styles.label}>Date · {formatWorkDate(draft.load_date)}</Text>
          <View style={styles.chipRow}>
            <Chip label="Today" active={draft.load_date === today} onPress={() => set({ load_date: today })} />
            <Chip label="Yesterday" active={draft.load_date === yesterday} onPress={() => set({ load_date: yesterday })} />
            <Chip label="Other day…" active={draft.load_date !== today && draft.load_date !== yesterday} onPress={() => setShowDate(true)} />
          </View>
          {showDate && <DateTimePicker value={new Date(`${draft.load_date}T12:00:00`)} mode="date" maximumDate={new Date()} onChange={onDateChange} />}
        </View>

        <View style={{ gap: 6 }}>
          <Text style={styles.label}>Truck</Text>
          <View style={styles.chipRow}>
            {view.trucks.map((t) => (
              <Chip key={t.id} label={t.name} active={draft.equipment_id === t.id} onPress={() => set({ equipment_id: t.id })} />
            ))}
          </View>
        </View>

        {isSpoil ? (
          <Field label="Tip" value={draft.place} onChange={(v) => set({ place: v })} placeholder="e.g. Wollert tip" />
        ) : (
          <>
            <View style={{ gap: 6 }}>
              <Text style={styles.label}>Quarry</Text>
              <TouchableOpacity style={styles.input} onPress={() => setPickQuarry(true)} accessibilityRole="button" accessibilityLabel="Pick the quarry">
                <Text style={{ fontSize: KEYBOARD_SHEET_INPUT_FONT_SIZE, color: quarry || draft.place ? colors.slate900 : colors.slate400 }}>
                  {quarry?.name ?? (draft.place || "Pick the quarry")}
                </Text>
              </TouchableOpacity>
            </View>
            <Field label="Material" value={draft.material} onChange={(v) => set({ material: v })} placeholder="e.g. Crushed rock 20mm, quarter minus" />
          </>
        )}

        <View style={{ gap: 6 }}>
          <Text style={styles.label}>Measured in</Text>
          <View style={styles.chipRow}>
            {(["tonne", "m3", "load"] as LoadUnit[]).map((u) => (
              <Chip key={u} label={UNIT_LABEL[u]} active={draft.unit === u} onPress={() => set({ unit: u })} />
            ))}
          </View>
        </View>
        <View style={styles.actions}>
          <Field label={`How much (${UNIT_LABEL[draft.unit].toLowerCase()})`} value={draft.quantity} onChange={(v) => set({ quantity: v })} numeric placeholder="off the docket" />
          <Field label="Km travelled" value={draft.km} onChange={(v) => set({ km: v })} numeric placeholder="e.g. 35" />
        </View>

        <Field label="Docket number" value={draft.docket_number} onChange={(v) => set({ docket_number: v })} placeholder="e.g. 123456" />
        <TouchableOpacity style={styles.secondaryWide} onPress={() => void photo()} accessibilityRole="button" accessibilityLabel="Photograph the docket">
          <Text style={styles.secondaryText}>{draft.photoUri ? "📷 Docket photo taken — retake" : "📷 Photograph the docket"}</Text>
        </TouchableOpacity>

        <View style={{ gap: 6 }}>
          <Text style={styles.label}>Charged to the builder?</Text>
          <View style={styles.chipRow}>
            <Chip label="Included in quote" active={draft.billing === "included"} onPress={() => set({ billing: "included" })} />
            <Chip label="Extra — charged" active={draft.billing === "extra"} onPress={() => set({ billing: "extra" })} />
          </View>
          <Text style={styles.meta}>
            {isSpoil ? "Spoil removal is almost always extra." : view.quarryIncluded === false ? "Quarry product is extra on this job." : "Quarry product is included on this job unless you change it."}
          </Text>
        </View>

        <View style={styles.actions}>
          <Field label="From (optional)" value={draft.from_text} onChange={(v) => set({ from_text: v })} placeholder={isSpoil ? view.siteLabel ?? "Job site" : quarry?.name ?? "Quarry"} />
          <Field label="To (optional)" value={draft.to_text} onChange={(v) => set({ to_text: v })} placeholder={isSpoil ? draft.place || "Tip" : view.siteLabel ?? "Job site"} />
        </View>
      </View>

      <SupplierPickerSheet
        visible={pickQuarry}
        suppliers={view.suppliers.map((s) => ({ id: s.id, name: s.name, email: null, pinOrder: s.pinOrder }))}
        recentIds={[]}
        onPick={(s) => {
          set({ supplier_id: s.id ?? null, place: s.name });
          setPickQuarry(false);
        }}
        onOther={(typed) => {
          set({ supplier_id: null, place: typed.trim() });
          setPickQuarry(false);
        }}
        onClose={() => setPickQuarry(false)}
      />
    </KeyboardSheet>
  );
}

function SignLoadsScreen({ jobId, date, loads, siteLabel, onCancel, onSigned }: {
  jobId: string;
  date: string;
  loads: TruckLoad[];
  siteLabel: string | null;
  onCancel: () => void;
  onSigned: (res: TruckLoadsState) => void;
}) {
  const ref = useRef<SignatureViewRef>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  function signPressed() {
    if (saving) return;
    if (!name.trim()) {
      Alert.alert("Name needed", "Enter the name of the builder's representative.");
      return;
    }
    Keyboard.dismiss();
    ref.current?.readSignature();
  }

  async function onSignature(dataUrl: string) {
    setSaving(true);
    try {
      onSigned(await signTruckLoads(jobId, loads.map((l) => l.id), name.trim(), dataUrl));
    } catch (e) {
      Alert.alert("Not signed", e instanceof Error ? e.message : "Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal visible animationType="slide" presentationStyle="fullScreen" onRequestClose={onCancel}>
      <SafeAreaView style={styles.signScreen}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, gap: 10 }}>
          <Text style={styles.signTitle}>{"Builder's sign-off — extra loads"}</Text>
          <Text style={styles.meta}>{formatWorkDate(date)}</Text>
          {loads.map((l) => (
            <Text key={l.id} style={styles.body}>
              • {l.direction === "material_in" ? "Material in" : "Spoil out"}: {loadSummary(l, siteLabel)}
            </Text>
          ))}
          <Text style={styles.meta}>{"These loads are charged as extras. Once signed they are locked and can't be edited."}</Text>
          <Field label="Name of the builder's representative" value={name} onChange={setName} placeholder="e.g. Sam Builder (site supervisor)" />
          <Text style={styles.label}>Signature</Text>
          <View style={styles.canvasWrap}>
            <Signature
              ref={ref}
              onOK={(sig) => void onSignature(sig)}
              onEmpty={() => Alert.alert("Signature needed", "Ask them to sign in the box.")}
              descriptionText=""
              clearText="Clear"
              confirmText="Sign"
              webStyle={signatureWebStyle}
              autoClear={false}
            />
          </View>
          <View style={styles.actions}>
            <TouchableOpacity style={styles.cancel} onPress={onCancel} disabled={saving} accessibilityRole="button">
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.save} onPress={signPressed} disabled={saving} accessibilityRole="button" accessibilityLabel="Sign">
              <Text style={styles.saveText}>{saving ? "Signing…" : "Sign"}</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  card: { marginHorizontal: 16, marginTop: 12, padding: 12, borderRadius: 12, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, gap: 8 },
  heading: { fontSize: 13, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", letterSpacing: 0.5 },
  dateHeading: { marginHorizontal: 16, marginTop: 16, fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase" },
  meta: { fontSize: 13, color: colors.slate500, flexShrink: 1 },
  warn: { fontSize: 13, color: colors.orange700 },
  error: { fontSize: 13, color: colors.red600 },
  body: { fontSize: 14, color: colors.slate700, flexShrink: 1 },
  bodyStrong: { fontSize: 14, fontWeight: "700", color: colors.slate900 },
  title: { fontSize: 16, fontWeight: "700", color: colors.slate900, flex: 1 },
  qty: { fontSize: 16, color: colors.slate900 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  pillText: { fontSize: 12, fontWeight: "700" },
  locked: { backgroundColor: colors.bg, borderRadius: 10, padding: 8, gap: 6 },
  lockedText: { fontSize: 13, color: colors.slate700 },
  signatureImg: { height: 60, backgroundColor: colors.white, borderRadius: 6 },
  primary: { minHeight: 52, justifyContent: "center", borderRadius: 10, alignItems: "center", backgroundColor: colors.blue600 },
  primaryHalf: { flex: 1, minHeight: 56, justifyContent: "center", borderRadius: 10, alignItems: "center", backgroundColor: colors.blue600 },
  primaryText: { fontSize: 16, fontWeight: "700", color: colors.white },
  secondary: { flex: 1, minHeight: 48, justifyContent: "center", borderRadius: 10, alignItems: "center", backgroundColor: colors.slate100, paddingHorizontal: 6 },
  secondaryWide: { minHeight: 52, justifyContent: "center", borderRadius: 10, alignItems: "center", backgroundColor: colors.slate100 },
  secondaryText: { fontSize: 15, fontWeight: "700", color: colors.slate700, textAlign: "center" },
  label: { fontSize: 13, fontWeight: "700", color: colors.slate700 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    minHeight: 48,
    fontSize: KEYBOARD_SHEET_INPUT_FONT_SIZE,
    backgroundColor: colors.card,
    color: colors.slate900,
    justifyContent: "center",
  },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { minHeight: 44, justifyContent: "center", paddingHorizontal: 14, borderRadius: 999, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border },
  chipActive: { backgroundColor: colors.blue600, borderColor: colors.blue600 },
  chipText: { fontSize: 14, fontWeight: "600", color: colors.slate700 },
  chipTextActive: { color: colors.white },
  actions: { flexDirection: "row", gap: 10 },
  cancel: { flex: 1, paddingVertical: 14, borderRadius: 10, alignItems: "center", backgroundColor: colors.slate100 },
  cancelText: { fontSize: 16, fontWeight: "700", color: colors.slate700 },
  save: { flex: 2, paddingVertical: 14, borderRadius: 10, alignItems: "center", backgroundColor: colors.blue600 },
  saveText: { fontSize: 16, fontWeight: "700", color: colors.white },
  signScreen: { flex: 1, padding: 16, backgroundColor: colors.card },
  signTitle: { fontSize: 20, fontWeight: "800", color: colors.slate900 },
  canvasWrap: { flex: 1, minHeight: 200, borderWidth: 2, borderColor: colors.border, borderRadius: 12, overflow: "hidden", backgroundColor: colors.bg },
});
