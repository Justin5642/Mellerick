import { useCallback, useEffect, useRef, useState } from "react";
import { View, Text, StyleSheet, TextInput, TouchableOpacity, ActivityIndicator, Alert, Modal, Platform, Image, KeyboardAvoidingView, Keyboard } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import DateTimePicker, { type DateTimePickerEvent } from "@react-native-community/datetimepicker";
import Signature, { type SignatureViewRef } from "react-native-signature-canvas";
import { colors } from "../../lib/theme";
import { localDateKey } from "../../lib/date";
import { cryptoIdGen } from "../../lib/data/ids";
import { netInfoConnectivity } from "../../lib/data/net/connectivity";
import { KeyboardSheet, KEYBOARD_SHEET_INPUT_FONT_SIZE } from "../KeyboardSheet";
import { MoneyText } from "../../design/components/MoneyText";
import { RoleGate } from "../../design/guards/RoleGate";
import { signatureWebStyle } from "./signature";
import {
  DAY_WORKS_OFFLINE,
  STATUS_LABEL,
  addDayWorksEntry,
  deleteDayWorksEntry,
  draftFromEntry,
  draftOption,
  emptyDraft,
  entryInputFromDraft,
  formatWorkDate,
  groupByDate,
  isOfflineError,
  loadDayWorks,
  optionKey,
  quantityProblem,
  quantityText,
  signDayWorksEntry,
  updateDayWorksEntry,
  type DayWorksDraft,
  type DayWorksEntry,
  type DayWorksState,
  type DayWorksWriteResult,
} from "../../lib/dayWorks";

// Day Works / Hire on the phone (Stage 2, Nov 2026). Justin's workflow 1 (wet
// hire: hours) and 2 (dry hire: days or engine hours): the crew add the day's
// line for a machine, then hand the phone to the builder's rep, who signs it
// on the glass. Once signed it is locked — for everyone, by the database.
//
// Online only (lib/dayWorks.ts says why). Quantities only for the crew: the
// server sends a technician no rate and no amount, and an office user's
// amounts render only through MoneyText inside a RoleGate.

type Loaded = Extract<DayWorksState, { ready: true }>;
type Status = { kind: "loading" } | { kind: "offline" } | { kind: "error"; message: string } | { kind: "not-ready" } | { kind: "ok"; view: Loaded };

const STATUS_STYLE: Record<string, { bg: string; text: string }> = {
  draft: { bg: colors.slate100, text: colors.slate700 },
  signed: { bg: colors.green100, text: colors.green600 },
  invoiced: { bg: colors.blue100, text: colors.blue600 },
  void: { bg: colors.red100, text: colors.red600 },
};

export function JobDayWorksTab({ jobId }: { jobId: string }) {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [draft, setDraft] = useState<DayWorksDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [signing, setSigning] = useState<DayWorksEntry | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // A new entry's id, made before the first Save and kept across retries, so a
  // retry after a dropped answer can't add the day twice (the server answers
  // a second add with the same id as already saved).
  const newEntryId = useRef(cryptoIdGen.newId());

  const show = useCallback((res: DayWorksState) => {
    setStatus(res.ready ? { kind: "ok", view: res } : { kind: "not-ready" });
  }, []);

  const load = useCallback(async () => {
    setStatus((s) => (s.kind === "ok" ? s : { kind: "loading" }));
    if (!(await netInfoConnectivity.isOnline().catch(() => true))) {
      setStatus({ kind: "offline" });
      return;
    }
    try {
      show(await loadDayWorks(jobId));
    } catch (e) {
      if (isOfflineError(e)) setStatus({ kind: "offline" });
      else setStatus({ kind: "error", message: e instanceof Error ? e.message : "Couldn't load Day Works." });
    }
  }, [jobId, show]);

  useEffect(() => {
    void load();
  }, [load]);

  function afterWrite(res: DayWorksWriteResult, done: string) {
    show(res);
    if (res.warning) Alert.alert(done, res.warning);
  }

  async function save() {
    if (!draft || saving || status.kind !== "ok") return;
    const built = entryInputFromDraft(draft, status.view.machines);
    if (!built.ok) {
      Alert.alert("Check the entry", built.error);
      return;
    }
    setSaving(true);
    try {
      const res = draft.id
        ? await updateDayWorksEntry(jobId, draft.id, built.input)
        : await addDayWorksEntry(jobId, { ...built.input, id: newEntryId.current });
      if (!draft.id) newEntryId.current = cryptoIdGen.newId();
      setDraft(null);
      afterWrite(res, draft.id ? "Entry updated" : "Entry added");
    } catch (e) {
      Alert.alert("Not saved", e instanceof Error ? e.message : "Try again.");
    } finally {
      setSaving(false);
    }
  }

  function confirmDelete(e: DayWorksEntry) {
    Alert.alert("Delete this entry?", `${e.equipment} on ${formatWorkDate(e.work_date)}.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          setBusyId(e.id);
          try {
            show(await deleteDayWorksEntry(jobId, e.id));
          } catch (err) {
            Alert.alert("Not deleted", err instanceof Error ? err.message : "Try again.");
          } finally {
            setBusyId(null);
          }
        },
      },
    ]);
  }

  function startSign(e: DayWorksEntry) {
    const problem = quantityProblem(e);
    if (problem) {
      Alert.alert("Not ready to sign", `${problem} Edit the entry first.`);
      return;
    }
    setSigning(e);
  }

  if (status.kind === "loading") return <ActivityIndicator style={{ marginTop: 24 }} color={colors.blue600} />;
  if (status.kind === "offline" || status.kind === "error") {
    return (
      <View style={styles.card}>
        <Text style={styles.heading}>Day Works</Text>
        <Text style={status.kind === "offline" ? styles.meta : styles.error}>{status.kind === "offline" ? DAY_WORKS_OFFLINE : status.message}</Text>
        <TouchableOpacity style={styles.addButton} onPress={() => void load()} accessibilityRole="button">
          <Text style={styles.addButtonText}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (status.kind === "not-ready") {
    return (
      <View style={styles.card}>
        <Text style={styles.meta}>{"Day Works isn't switched on yet. Ask the office."}</Text>
      </View>
    );
  }

  const view = status.view;
  const attachmentName = (id: string) => view.attachments.find((a) => a.id === id)?.name ?? "Attachment";
  const groups = groupByDate(view.entries);

  return (
    <View style={{ paddingBottom: 24 }}>
      <View style={styles.card}>
        <Text style={styles.heading}>Day Works / Hire</Text>
        <Text style={styles.meta}>{"One line per machine per day, signed by the builder's rep. Charged separately from the quoted work."}</Text>
        {view.machines.length === 0 ? (
          <Text style={styles.warn}>No machines are set up for hire yet. Ask the office to set them up in Fleet.</Text>
        ) : (
          <TouchableOpacity style={styles.primary} onPress={() => setDraft(emptyDraft(localDateKey(new Date())))} accessibilityRole="button" accessibilityLabel="Add day">
            <Text style={styles.primaryText}>+ Add day</Text>
          </TouchableOpacity>
        )}
      </View>

      {view.clashes.length > 0 && (
        <View style={[styles.card, styles.clashCard]}>
          {view.clashes.map((c) => (
            <Text key={`${c.attachment}-${c.work_date}`} style={styles.clashText}>
              {`⚠ ${c.attachment} is ticked on ${c.machines.join(" and ")} on ${formatWorkDate(c.work_date)}. It can only be on one — check which is right so it isn't charged twice.`}
            </Text>
          ))}
        </View>
      )}

      {view.isOffice && view.pricing && view.pricing.byCostCentre.length > 0 && (
        <RoleGate roles={["office", "admin"]}>
          <View style={styles.card}>
            <Text style={styles.heading}>By cost centre (ex GST)</Text>
            {view.pricing.byCostCentre.map((c) => (
              <View key={c.name} style={styles.row}>
                <Text style={styles.body}>{c.name}</Text>
                <MoneyText amount={c.amount} style={styles.bodyStrong} />
              </View>
            ))}
            <View style={styles.row}>
              <Text style={styles.meta}>Signed, not yet invoiced</Text>
              <MoneyText amount={view.pricing.uninvoicedSigned} style={styles.bodyStrong} />
            </View>
          </View>
        </RoleGate>
      )}

      {groups.length === 0 ? (
        <Text style={[styles.meta, { textAlign: "center", marginTop: 12 }]}>No Day Works on this job yet.</Text>
      ) : (
        groups.map((g) => (
          <View key={g.date}>
            <Text style={styles.dateHeading}>{formatWorkDate(g.date)}</Text>
            {g.entries.map((e) => {
              const st = STATUS_STYLE[e.status] ?? STATUS_STYLE.draft;
              const clashes = view.clashes.filter((c) => c.entry_ids.includes(e.id));
              const total = view.pricing?.entries[e.id]?.total;
              return (
                <View key={e.id} style={[styles.card, e.status === "void" && { opacity: 0.6 }]}>
                  <View style={styles.row}>
                    <Text style={styles.machine} numberOfLines={2}>
                      {e.equipment} <Text style={styles.meta}>· {e.hire_label}</Text>
                    </Text>
                    <View style={[styles.pill, { backgroundColor: st.bg }]}>
                      <Text style={[styles.pillText, { color: st.text }]}>{STATUS_LABEL[e.status]}</Text>
                    </View>
                  </View>
                  <Text style={styles.qty}>{quantityText(e)}</Text>
                  {e.attachment_ids.length > 0 && (
                    <Text style={styles.meta}>
                      With: {e.attachment_ids.map(attachmentName).join(", ")}
                      {clashes.length > 0 ? " · also ticked on another machine that day" : ""}
                    </Text>
                  )}
                  {!!e.description && <Text style={styles.body}>{e.description}</Text>}
                  <Text style={styles.meta}>
                    {e.cost_centre ?? "No cost centre"}
                    {e.created_by_name ? ` · entered by ${e.created_by_name}` : ""}
                  </Text>
                  {view.isOffice && view.pricing && (
                    <RoleGate roles={["office", "admin"]}>
                      {total === null ? <Text style={styles.warn}>No rate set</Text> : <MoneyText amount={total} style={styles.bodyStrong} />}
                    </RoleGate>
                  )}

                  {e.status !== "draft" && !!e.signer_name && (
                    <View style={styles.locked}>
                      <Text style={styles.lockedText}>
                        🔒 Signed by {e.signer_name}
                        {e.signed_at ? ` on ${new Date(e.signed_at).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })}` : ""}. Locked.
                      </Text>
                      {!!e.signature_url && <Image source={{ uri: e.signature_url }} style={styles.signatureImg} resizeMode="contain" accessibilityLabel={`Signature of ${e.signer_name}`} />}
                    </View>
                  )}
                  {e.status === "void" && !!e.void_reason && <Text style={styles.error}>Void: {e.void_reason}</Text>}

                  {e.status === "draft" && (
                    <>
                      <TouchableOpacity style={styles.primary} onPress={() => startSign(e)} accessibilityRole="button" accessibilityLabel="Get builder to sign">
                        <Text style={styles.primaryText}>Get builder to sign</Text>
                      </TouchableOpacity>
                      <View style={styles.actions}>
                        <TouchableOpacity style={styles.secondary} onPress={() => setDraft(draftFromEntry(e))} accessibilityRole="button">
                          <Text style={styles.secondaryText}>Edit</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.secondary} onPress={() => confirmDelete(e)} disabled={busyId === e.id} accessibilityRole="button">
                          <Text style={[styles.secondaryText, { color: colors.red600 }]}>{busyId === e.id ? "Deleting…" : "Delete"}</Text>
                        </TouchableOpacity>
                      </View>
                    </>
                  )}
                </View>
              );
            })}
          </View>
        ))
      )}

      {draft && (
        <EntrySheet
          draft={draft}
          setDraft={setDraft}
          view={view}
          saving={saving}
          onSave={() => void save()}
          onCancel={() => setDraft(null)}
        />
      )}

      {signing && (
        <SignOffScreen
          jobId={jobId}
          entry={signing}
          onCancel={() => setSigning(null)}
          onSigned={(res) => {
            setSigning(null);
            show(res);
            Alert.alert("Signed off", "This entry is now locked.");
          }}
        />
      )}
    </View>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={[styles.chip, active && styles.chipActive]} onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: active }}>
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

function Field({ label, value, onChange, numeric, placeholder, multiline }: { label: string; value: string; onChange: (v: string) => void; numeric?: boolean; placeholder?: string; multiline?: boolean }) {
  return (
    <View style={{ flex: 1, gap: 4 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={[styles.input, multiline && { minHeight: 80, textAlignVertical: "top" }]}
        value={value}
        onChangeText={onChange}
        keyboardType={numeric ? "decimal-pad" : "default"}
        placeholder={placeholder}
        placeholderTextColor={colors.slate400}
        multiline={multiline}
        accessibilityLabel={label}
      />
    </View>
  );
}

function EntrySheet({ draft, setDraft, view, saving, onSave, onCancel }: {
  draft: DayWorksDraft;
  setDraft: (d: DayWorksDraft) => void;
  view: Loaded;
  saving: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  const [showDate, setShowDate] = useState(false);
  const set = (patch: Partial<DayWorksDraft>) => setDraft({ ...draft, ...patch });
  const machine = view.machines.find((m) => m.id === draft.equipment_id);
  const opt = draftOption(draft, view.machines);
  const today = localDateKey(new Date());
  const yesterday = localDateKey(new Date(Date.now() - 86_400_000));

  function pickMachine(id: string) {
    const m = view.machines.find((x) => x.id === id);
    set({ equipment_id: id, optionKey: m && m.options.length === 1 ? optionKey(m.options[0]) : "" });
  }

  function onDateChange(event: DateTimePickerEvent, selected?: Date) {
    setShowDate(Platform.OS === "ios");
    if (event.type === "set" && selected) set({ work_date: localDateKey(selected) });
  }

  return (
    <KeyboardSheet
      visible
      onRequestClose={onCancel}
      title={draft.id ? "Edit day" : "Add day"}
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
          <Text style={styles.label}>Date · {formatWorkDate(draft.work_date)}</Text>
          <View style={styles.chipRow}>
            <Chip label="Today" active={draft.work_date === today} onPress={() => set({ work_date: today })} />
            <Chip label="Yesterday" active={draft.work_date === yesterday} onPress={() => set({ work_date: yesterday })} />
            <Chip label="Other day…" active={draft.work_date !== today && draft.work_date !== yesterday} onPress={() => setShowDate(true)} />
          </View>
          {showDate && <DateTimePicker value={new Date(`${draft.work_date}T12:00:00`)} mode="date" maximumDate={new Date()} onChange={onDateChange} />}
        </View>

        <View style={{ gap: 6 }}>
          <Text style={styles.label}>Machine</Text>
          <View style={styles.chipRow}>
            {view.machines.map((m) => (
              <Chip key={m.id} label={m.name} active={draft.equipment_id === m.id} onPress={() => pickMachine(m.id)} />
            ))}
          </View>
        </View>

        {machine && machine.options.length > 1 && (
          <View style={{ gap: 6 }}>
            <Text style={styles.label}>Hired as</Text>
            <View style={styles.chipRow}>
              {machine.options.map((o) => (
                <Chip key={optionKey(o)} label={o.label} active={draft.optionKey === optionKey(o)} onPress={() => set({ optionKey: optionKey(o) })} />
              ))}
            </View>
          </View>
        )}

        {opt && (
          <>
            <Text style={styles.meta}>
              {opt.label}
              {opt.fuel_included ? " · fuel included" : opt.hire_type === "dry" ? " · hirer supplies fuel" : ""}
              {opt.whole_days_only ? " · full days only" : ""}
            </Text>
            {opt.hire_unit === "hour" && <Field label="Hours" value={draft.hours} onChange={(v) => set({ hours: v })} numeric placeholder="e.g. 7.5" />}
            {opt.hire_unit === "day" && <Field label="Days" value={draft.days} onChange={(v) => set({ days: v })} numeric placeholder={opt.whole_days_only ? "e.g. 1" : "e.g. 1 or 0.5"} />}
            {opt.hire_unit === "engine_hour" && (
              <View style={styles.actions}>
                <Field label="Meter opening" value={draft.meter_open} onChange={(v) => set({ meter_open: v })} numeric />
                <Field label="Meter closing" value={draft.meter_close} onChange={(v) => set({ meter_close: v })} numeric />
              </View>
            )}
            {(opt.hire_unit === "km" || opt.hire_unit === "move") && (
              <Field label={opt.hire_unit === "move" ? "Loaded km" : "Km"} value={draft.km} onChange={(v) => set({ km: v })} numeric placeholder="e.g. 42" />
            )}
            {(opt.hire_unit === "move" || opt.hire_type === "cartage") && (
              <View style={styles.actions}>
                <Field label="From" value={draft.pickup} onChange={(v) => set({ pickup: v })} placeholder="Pick-up" />
                <Field label="To" value={draft.dropoff} onChange={(v) => set({ dropoff: v })} placeholder="Drop-off" />
              </View>
            )}
          </>
        )}

        {opt && opt.hire_type !== "float" && view.attachments.length > 0 && (
          <View style={{ gap: 6 }}>
            <Text style={styles.label}>Attachments on the machine (a full day each)</Text>
            <View style={styles.chipRow}>
              {view.attachments.map((a) => {
                const on = draft.attachment_ids.includes(a.id);
                return (
                  <Chip
                    key={a.id}
                    label={`${on ? "✓ " : ""}${a.name}`}
                    active={on}
                    onPress={() => set({ attachment_ids: on ? draft.attachment_ids.filter((x) => x !== a.id) : [...draft.attachment_ids, a.id] })}
                  />
                );
              })}
            </View>
          </View>
        )}

        <Field label="Description of the works" value={draft.description} onChange={(v) => set({ description: v })} placeholder="What the machine did today" multiline />
      </View>
    </KeyboardSheet>
  );
}

function SignOffScreen({ jobId, entry, onCancel, onSigned }: { jobId: string; entry: DayWorksEntry; onCancel: () => void; onSigned: (res: DayWorksWriteResult) => void }) {
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
      onSigned(await signDayWorksEntry(jobId, entry.id, name.trim(), dataUrl));
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
          <Text style={styles.signTitle}>{"Builder's sign-off"}</Text>
          <Text style={styles.body}>
            {entry.equipment} · {formatWorkDate(entry.work_date)} · {quantityText(entry)}
            {entry.description ? `\n${entry.description}` : ""}
          </Text>
          <Text style={styles.meta}>{"Once signed, this line is locked and can't be edited."}</Text>
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
  clashCard: { backgroundColor: colors.yellow100, borderColor: colors.yellow700 },
  clashText: { fontSize: 13, color: colors.yellow700 },
  heading: { fontSize: 13, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", letterSpacing: 0.5 },
  dateHeading: { marginHorizontal: 16, marginTop: 16, fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase" },
  meta: { fontSize: 13, color: colors.slate500 },
  warn: { fontSize: 13, color: colors.orange700 },
  error: { fontSize: 13, color: colors.red600 },
  body: { fontSize: 14, color: colors.slate700, flexShrink: 1 },
  bodyStrong: { fontSize: 14, fontWeight: "700", color: colors.slate900 },
  machine: { fontSize: 16, fontWeight: "700", color: colors.slate900, flex: 1 },
  qty: { fontSize: 16, color: colors.slate900 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  pill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  pillText: { fontSize: 12, fontWeight: "700" },
  locked: { backgroundColor: colors.bg, borderRadius: 10, padding: 8, gap: 6 },
  lockedText: { fontSize: 13, color: colors.slate700 },
  signatureImg: { height: 60, backgroundColor: colors.white, borderRadius: 6 },
  addButton: { paddingVertical: 14, borderRadius: 10, alignItems: "center", backgroundColor: colors.slate100 },
  addButtonText: { fontSize: 16, fontWeight: "700", color: colors.slate700 },
  primary: { minHeight: 52, justifyContent: "center", borderRadius: 10, alignItems: "center", backgroundColor: colors.blue600 },
  primaryText: { fontSize: 16, fontWeight: "700", color: colors.white },
  secondary: { flex: 1, minHeight: 48, justifyContent: "center", borderRadius: 10, alignItems: "center", backgroundColor: colors.slate100 },
  secondaryText: { fontSize: 15, fontWeight: "700", color: colors.slate700 },
  label: { fontSize: 13, fontWeight: "700", color: colors.slate700 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: KEYBOARD_SHEET_INPUT_FONT_SIZE,
    backgroundColor: colors.card,
    color: colors.slate900,
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
  canvasWrap: { flex: 1, minHeight: 220, borderWidth: 2, borderColor: colors.border, borderRadius: 12, overflow: "hidden", backgroundColor: colors.bg },
});
