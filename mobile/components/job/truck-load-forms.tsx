import { useRef, useState } from "react";
import { View, Text, StyleSheet, TextInput, TouchableOpacity, Alert, Modal, Platform, KeyboardAvoidingView, Keyboard } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import DateTimePicker, { type DateTimePickerEvent } from "@react-native-community/datetimepicker";
import Signature, { type SignatureViewRef } from "react-native-signature-canvas";
import * as ImagePicker from "expo-image-picker";
import { colors } from "../../lib/theme";
import { localDateKey } from "../../lib/date";
import { cryptoIdGen } from "../../lib/data/ids";
import { prepareImage } from "../../lib/imageUpload";
import { KeyboardSheet, KEYBOARD_SHEET_INPUT_FONT_SIZE } from "../KeyboardSheet";
import { signatureWebStyle } from "./signature";
import { SupplierPickerSheet } from "./supplier-picker";
import { formatWorkDate } from "../../lib/dayWorks";
import { KmLookup } from "./km-lookup";
import { truckLoadTripEnds } from "../../lib/distanceTrip";
import {
  UNIT_LABEL,
  addTruckLoad,
  attachDocketPhoto,
  loadInputFromDraft,
  loadSummary,
  signTruckLoads,
  updateTruckLoad,
  type LoadUnit,
  type TruckLoad,
  type TruckLoadDraft,
  type TruckLoadsState,
  type TruckLoadsWriteResult,
} from "../../lib/truckLoads";

// The truck-load form and the builder's sign-off, shared by the job's Day
// Works → Truck loads section (./truck-loads.tsx) and the driver's run sheet
// (components/run/todays-run-screen.tsx) — one form, so the two can never ask
// for different things. Both write through the existing
// /api/jobs/[id]/cartage-loads routes (lib/truckLoads.ts). No money here.

/** What the form needs to know about the job and the fleet: names only. */
export interface TruckLoadFormContext {
  trucks: { id: string; name: string }[];
  suppliers: { id: string; name: string; pinOrder: number | null }[];
  quarryIncluded: boolean | null;
  siteLabel: string | null;
}

/** Attach a docket photo to a saved load; resolves with the server's fresh section. */
export async function uploadDocketPhoto(jobId: string, loadId: string, uri: string): Promise<TruckLoadsWriteResult> {
  const { base64 } = await prepareImage(uri, { base64: true });
  if (!base64) throw new Error("Couldn't prepare the photo — take it again.");
  return attachDocketPhoto(jobId, loadId, base64);
}

export async function takePhoto(): Promise<string | null> {
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

/**
 * Add or edit one load on `jobId`, then (if one was taken) upload its docket
 * photo. `onSaved` gets each fresh answer from the server; `onClose` is called
 * once the load is saved, or on Cancel.
 */
export function TruckLoadSheet({ jobId, draft, setDraft, form, onSaved, onClose }: {
  jobId: string;
  draft: TruckLoadDraft;
  setDraft: (d: TruckLoadDraft) => void;
  form: TruckLoadFormContext;
  onSaved: (res: TruckLoadsWriteResult) => void;
  onClose: () => void;
}) {
  const [showDate, setShowDate] = useState(false);
  const [pickQuarry, setPickQuarry] = useState(false);
  const [saving, setSaving] = useState(false);
  // A new load's id, made before the first Save and kept across retries, so a
  // retry after a dropped answer can't log the trip twice.
  const newLoadId = useRef(cryptoIdGen.newId());
  const set = (patch: Partial<TruckLoadDraft>) => setDraft({ ...draft, ...patch });
  const today = localDateKey(new Date());
  const yesterday = localDateKey(new Date(Date.now() - 86_400_000));
  const isSpoil = draft.direction === "spoil_out";
  const quarry = form.suppliers.find((s) => s.id === draft.supplier_id);

  function onDateChange(event: DateTimePickerEvent, selected?: Date) {
    setShowDate(Platform.OS === "ios");
    if (event.type === "set" && selected) set({ load_date: localDateKey(selected) });
  }

  async function photo() {
    const uri = await takePhoto();
    if (uri) set({ photoUri: uri });
  }

  async function save() {
    if (saving) return;
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
      onSaved(res);
      const docket = draft.photoUri;
      onClose();
      if (docket) {
        try {
          onSaved(await uploadDocketPhoto(jobId, loadId, docket));
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

  return (
    <KeyboardSheet
      visible
      onRequestClose={onClose}
      title={`${draft.id ? "Edit" : "Add"} ${isSpoil ? "spoil out" : "material in"}`}
      footer={
        <View style={styles.actions}>
          <TouchableOpacity style={styles.cancel} onPress={onClose} accessibilityRole="button">
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.save} onPress={() => void save()} disabled={saving} accessibilityRole="button">
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
            {form.trucks.map((t) => (
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
        <KmLookup jobId={jobId} km={draft.km} ends={() => truckLoadTripEnds({ ...draft, place: quarry?.name ?? draft.place })} onKm={(km) => set({ km })} />

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
            {isSpoil ? "Spoil removal is almost always extra." : form.quarryIncluded === false ? "Quarry product is extra on this job." : "Quarry product is included on this job unless you change it."}
          </Text>
        </View>

        <View style={styles.actions}>
          <Field label="From (optional)" value={draft.from_text} onChange={(v) => set({ from_text: v })} placeholder={isSpoil ? form.siteLabel ?? "Job site" : quarry?.name ?? "Quarry"} />
          <Field label="To (optional)" value={draft.to_text} onChange={(v) => set({ to_text: v })} placeholder={isSpoil ? draft.place || "Tip" : form.siteLabel ?? "Job site"} />
        </View>
      </View>

      <SupplierPickerSheet
        visible={pickQuarry}
        suppliers={form.suppliers.map((s) => ({ id: s.id, name: s.name, email: null, pinOrder: s.pinOrder }))}
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

/** The builder's rep signs the day's extra loads on `jobId` at once: their name and one signature. */
export function SignLoadsScreen({ jobId, date, loads, siteLabel, onCancel, onSigned }: {
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

/** Shared by the Truck loads section and the run sheet. */
export const truckLoadStyles = StyleSheet.create({
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
const styles = truckLoadStyles;
