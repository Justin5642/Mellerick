import { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, TextInput, Alert, ActivityIndicator } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { colors } from "../../lib/theme";
import { KeyboardSheet, KEYBOARD_SHEET_INPUT_FONT_SIZE } from "../KeyboardSheet";
import { MoneyText } from "../../design/components/MoneyText";
import { RoleGate } from "../../design/guards/RoleGate";
import { prepareImage } from "../../lib/imageUpload";
import { cryptoIdGen } from "../../lib/data/ids";
import { openExternalUrl } from "../../lib/open-external-url";
import { getEquipmentReceiptSignedUrl } from "../../lib/data/reads/fleet";
import { SERVICE_TYPE_LABELS, dueLabel, serviceDue, sortRecords, type LiveHours, type ServiceRecord } from "../../lib/serviceDue";
import { applyServiceInvoiceRead } from "../../lib/serviceInvoiceForm";
import {
  MAX_UPLOAD_BYTES,
  NEW_EXPENSE,
  NO_EXPENSE,
  base64Bytes,
  blankServiceForm,
  deleteServiceRecord,
  loadServiceHistory,
  readNoteFor,
  readServiceInvoice,
  saveServiceRecord,
  serviceFormProblem,
  servicePayload,
  type ServiceExpense,
  type ServiceForm,
  type ServiceHistory as History,
} from "../../lib/fleetOffice";

// Fleet → Service history on the phone (office/admin): the web's
// components/fleet/equipment-service-records.tsx. Online only — service
// records are in no PowerSync stream. "Log a service" takes the invoice as a
// photo (camera or library; no document picker is in the app binary, so a
// PDF invoice is dropped on the website), reads it automatically
// (/api/fleet/service-invoice/read) and fills only what's still empty.
// Nothing is saved until Save; the server uploads the invoice first, so a
// failed upload saves nothing.

const fmtDate = (k: string) => new Date(`${k}T00:00:00`).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });

export function ServiceHistory({ equipmentId, today, onCostLogged, liveHours = null }: { equipmentId: string; today: string; onCostLogged: () => void; liveHours?: LiveHours | null }) {
  const [history, setHistory] = useState<History | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<ServiceForm | null>(null);
  const [formId, setFormId] = useState("");
  const [invoice, setInvoice] = useState<{ base64: string } | null>(null);
  const [reading, setReading] = useState(false);
  const [readNote, setReadNote] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      setHistory(await loadServiceHistory(equipmentId));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load the service history.");
    }
  }, [equipmentId]);
  useEffect(() => { void load(); }, [load]);

  const records = useMemo(() => sortRecords(history?.records ?? []), [history]);
  const due = useMemo(() => serviceDue(history?.records ?? [], today, liveHours), [history, today, liveHours]);
  const expenseById = useMemo(() => new Map((history?.expenses ?? []).map((e) => [e.id, e])), [history]);
  const linkable = useMemo(() => {
    const linked = new Set((history?.records ?? []).map((r) => r.expense_id).filter(Boolean));
    return (history?.expenses ?? []).filter((e) => !linked.has(e.id));
  }, [history]);

  function openForm() {
    setForm(blankServiceForm(today));
    setFormId(cryptoIdGen.newId());
    setInvoice(null);
    setReadNote(null);
  }
  const set = (k: keyof ServiceForm) => (v: string) => setForm((f) => f && { ...f, [k]: v });

  async function pickInvoice(fromCamera: boolean) {
    const perm = fromCamera ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert("Permission needed", fromCamera ? "Camera access is required." : "Photo library access is required."); return; }
    const result = fromCamera ? await ImagePicker.launchCameraAsync({ quality: 1 }) : await ImagePicker.launchImageLibraryAsync({ quality: 1 });
    if (result.canceled || !result.assets?.length) return;
    let base64: string | undefined;
    try {
      // The one downscale + compress pass (≤1600px, JPEG 0.7) — still legible.
      base64 = (await prepareImage(result.assets[0].uri, { base64: true })).base64;
    } catch {
      base64 = undefined;
    }
    if (!base64) { Alert.alert("Couldn't use that photo", "Try taking it again."); return; }
    setInvoice({ base64 });
    setForm((f) => f && (f.expense === NEW_EXPENSE ? f : { ...f, expense: NEW_EXPENSE }));
    setReadNote(null);
    if (base64Bytes(base64) > MAX_UPLOAD_BYTES) {
      setReadNote({ tone: "warn", text: "Too large to read or save (over 3 MB). Take the photo again closer in." });
      return;
    }
    setReading(true);
    try {
      const { read } = await readServiceInvoice(base64);
      setForm((f) => f && applyServiceInvoiceRead(f, read, today, NEW_EXPENSE).form);
      setReadNote(readNoteFor(read));
    } catch (e) {
      setReadNote({ tone: "warn", text: e instanceof Error ? e.message : "The invoice could not be read. Fill the details in by hand." });
    } finally {
      setReading(false);
    }
  }

  async function save() {
    if (!form || saving) return;
    const problem = serviceFormProblem(form);
    if (problem) { Alert.alert("Check the service", problem); return; }
    if (invoice && form.expense === NEW_EXPENSE && base64Bytes(invoice.base64) > MAX_UPLOAD_BYTES) {
      Alert.alert("Invoice too large", "Remove the photo or take it again closer in.");
      return;
    }
    setSaving(true);
    try {
      const inv = invoice && form.expense === NEW_EXPENSE ? { fileBase64: invoice.base64, fileName: `service-invoice-${form.service_date}.jpg` } : null;
      const res = await saveServiceRecord(equipmentId, servicePayload(form, formId, inv));
      setForm(null);
      setInvoice(null);
      setReadNote(null);
      await load();
      if (res.expense) onCostLogged();
    } catch (e) {
      Alert.alert("Couldn't save the service", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setSaving(false);
    }
  }

  function confirmDelete(r: ServiceRecord) {
    Alert.alert("Delete service record", `Delete the ${fmtDate(r.service_date)} service? Its cost (if any) stays in the expenses.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await deleteServiceRecord(equipmentId, r.id);
            await load();
          } catch (e) {
            Alert.alert("Couldn't delete", e instanceof Error ? e.message : "Please try again.");
          }
        },
      },
    ]);
  }

  async function viewInvoice(path: string) {
    try {
      const url = await getEquipmentReceiptSignedUrl(path);
      if (url) void openExternalUrl(url, "the invoice");
      else Alert.alert("Invoice unavailable", "It may still be uploading, or you're offline.");
    } catch (e) {
      Alert.alert("Invoice unavailable", e instanceof Error ? e.message : "Please try again.");
    }
  }

  const dueTone = due.state === "overdue" ? styles.dueOverdue : due.state === "due_soon" ? styles.dueSoon : null;

  return (
    <RoleGate roles={["office", "admin"]}>
      <View style={styles.sectionHead}>
        <Text style={styles.section}>Service history</Text>
        {history?.ready && !form && (
          <TouchableOpacity onPress={openForm} style={styles.addBtn} accessibilityLabel="Log a service">
            <Ionicons name="add" size={16} color={colors.blue600} /><Text style={styles.addText}>Log a service</Text>
          </TouchableOpacity>
        )}
      </View>
      <View style={styles.card}>
        {loadError ? (
          <View>
            <Text style={styles.empty}>{loadError}</Text>
            <TouchableOpacity onPress={() => void load()}><Text style={styles.retry}>Try again</Text></TouchableOpacity>
          </View>
        ) : !history ? (
          <ActivityIndicator color={colors.blue600} />
        ) : !history.ready ? (
          <Text style={styles.empty}>Service records aren&apos;t switched on in this database yet. Expenses and receipts still work below.</Text>
        ) : (
          <>
            <View style={[styles.due, dueTone]}>
              <Ionicons name={due.state === "overdue" ? "warning-outline" : "calendar-outline"} size={15} color={due.state === "overdue" ? colors.red600 : due.state === "due_soon" ? colors.orange700 : colors.slate700} />
              <View style={{ flex: 1 }}>
                <Text style={styles.dueText}>{dueLabel(due)}{due.dueDate ? ` (${fmtDate(due.dueDate)})` : ""}</Text>
                {due.dueKm != null && <Text style={styles.meta}>Due at {due.dueKm.toLocaleString("en-AU")} km{due.lastKm != null ? ` · last recorded ${due.lastKm.toLocaleString("en-AU")} km` : ""}</Text>}
                {due.dueHours != null && <Text style={styles.meta}>Due at {due.dueHours.toLocaleString("en-AU")} h{due.liveHours != null ? ` · meter now ${due.liveHours.toLocaleString("en-AU")} h (Komtrax)` : due.lastHours != null ? ` · last recorded ${due.lastHours.toLocaleString("en-AU")} h` : ""}</Text>}
              </View>
            </View>
            {records.length === 0 ? <Text style={styles.empty}>No services recorded yet.</Text> : records.map((r) => {
              const exp = r.expense_id ? expenseById.get(r.expense_id) : null;
              const nextDue = [
                r.next_due_date && fmtDate(r.next_due_date),
                r.next_due_km != null && `${r.next_due_km.toLocaleString("en-AU")} km`,
                r.next_due_hours != null && `${Number(r.next_due_hours).toLocaleString("en-AU")} h`,
              ].filter(Boolean).join(" or ");
              return (
                <View key={r.id} style={styles.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowTitle}>{SERVICE_TYPE_LABELS[r.service_type] ?? r.service_type} · {fmtDate(r.service_date)}</Text>
                    <Text style={styles.meta}>
                      {[r.provider, r.odometer_km != null ? `${r.odometer_km.toLocaleString("en-AU")} km` : null, r.engine_hours != null ? `${Number(r.engine_hours).toLocaleString("en-AU")} engine h` : null].filter(Boolean).join(" · ")}
                    </Text>
                    {exp && (
                      <View style={styles.expLine}>
                        <Ionicons name="receipt-outline" size={12} color={colors.slate500} />
                        <MoneyText amount={Number(exp.amount)} style={styles.meta} />
                        <Text style={styles.meta}> ex GST{exp.invoice_number ? ` · inv ${exp.invoice_number}` : ""}</Text>
                      </View>
                    )}
                    {exp?.receipt_storage_path && (
                      <TouchableOpacity onPress={() => viewInvoice(exp.receipt_storage_path!)} style={styles.link} hitSlop={8}>
                        <Ionicons name="open-outline" size={13} color={colors.blue600} /><Text style={styles.linkText}>View invoice</Text>
                      </TouchableOpacity>
                    )}
                    {r.work_done ? <Text style={styles.work}>{r.work_done}</Text> : null}
                    {nextDue ? <Text style={styles.meta}>Next due: {nextDue}</Text> : null}
                  </View>
                  <TouchableOpacity onPress={() => confirmDelete(r)} accessibilityLabel="Delete service record" hitSlop={8}>
                    <Ionicons name="trash-outline" size={18} color={colors.slate400} />
                  </TouchableOpacity>
                </View>
              );
            })}
          </>
        )}
      </View>

      <KeyboardSheet
        visible={!!form}
        onRequestClose={() => !saving && setForm(null)}
        title={<Text style={styles.sheetTitle}>Log a service</Text>}
        footer={
          <View style={styles.actions}>
            <TouchableOpacity style={styles.cancel} onPress={() => setForm(null)} disabled={saving}><Text style={styles.cancelText}>Cancel</Text></TouchableOpacity>
            <TouchableOpacity style={[styles.saveBtn, (saving || reading) && styles.disabled]} onPress={save} disabled={saving || reading}>
              <Text style={styles.saveText}>{saving ? "Saving…" : "Save service"}</Text>
            </TouchableOpacity>
          </View>
        }
      >
        {form && (
          <>
            <Text style={styles.fieldLabel}>Service invoice (photo)</Text>
            {invoice ? (
              <View style={styles.chosen}>
                <Ionicons name="checkmark-circle" size={16} color={colors.green600} />
                <Text style={styles.chosenText}>Invoice photo attached</Text>
                <TouchableOpacity onPress={() => { setInvoice(null); setReadNote(null); }} hitSlop={8} disabled={reading}><Text style={styles.remove}>Remove</Text></TouchableOpacity>
              </View>
            ) : (
              <View style={styles.twoCol}>
                <TouchableOpacity style={styles.pickBtn} onPress={() => pickInvoice(true)}><Ionicons name="camera-outline" size={16} color={colors.blue600} /><Text style={styles.pickText}>Camera</Text></TouchableOpacity>
                <TouchableOpacity style={styles.pickBtn} onPress={() => pickInvoice(false)}><Ionicons name="image-outline" size={16} color={colors.blue600} /><Text style={styles.pickText}>Photos</Text></TouchableOpacity>
              </View>
            )}
            <Text style={styles.hint}>Read automatically and saved with the service&apos;s cost. A PDF invoice can be dropped on the website.</Text>
            {reading && <View style={styles.noteRow}><ActivityIndicator size="small" color={colors.blue600} /><Text style={styles.noteText}>Reading the invoice…</Text></View>}
            {readNote && <Text style={[styles.noteText, readNote.tone === "ok" ? styles.noteOk : styles.noteWarn]}>{readNote.text}</Text>}

            <Field label="Date (YYYY-MM-DD)" value={form.service_date} onChange={set("service_date")} />
            <Text style={styles.fieldLabel}>Type</Text>
            <View style={styles.chips}>
              {Object.entries(SERVICE_TYPE_LABELS).map(([v, l]) => (
                <TouchableOpacity key={v} style={[styles.chip, form.service_type === v && styles.chipActive]} onPress={() => set("service_type")(v)}>
                  <Text style={[styles.chipText, form.service_type === v && styles.chipTextActive]}>{l}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Field label="Done by" value={form.provider} onChange={set("provider")} placeholder="Workshop or mechanic" />
            <View style={styles.twoCol}>
              <View style={{ flex: 1 }}><Field label="Odometer (km)" value={form.odometer_km} onChange={set("odometer_km")} num /></View>
              <View style={{ flex: 1 }}><Field label="Engine hours" value={form.engine_hours} onChange={set("engine_hours")} num /></View>
            </View>
            <Field label="Work done" value={form.work_done} onChange={set("work_done")} multiline placeholder="e.g. Oil and filters, front pads" />

            <Text style={styles.subhead}>Next service due</Text>
            <Field label="Date (YYYY-MM-DD)" value={form.next_due_date} onChange={set("next_due_date")} />
            <View style={styles.twoCol}>
              <View style={{ flex: 1 }}><Field label="Odometer (km)" value={form.next_due_km} onChange={set("next_due_km")} num /></View>
              <View style={{ flex: 1 }}><Field label="Engine hours" value={form.next_due_hours} onChange={set("next_due_hours")} num /></View>
            </View>

            <Text style={styles.subhead}>Invoice for this service</Text>
            <ExpenseChoice label="No cost / not invoiced yet" active={form.expense === NO_EXPENSE} onPress={() => set("expense")(NO_EXPENSE)} />
            <ExpenseChoice label="Log the cost now" active={form.expense === NEW_EXPENSE} onPress={() => set("expense")(NEW_EXPENSE)} />
            {linkable.map((e) => (
              <ExpenseChoice key={e.id} active={form.expense === e.id} onPress={() => set("expense")(e.id)} label={linkLabel(e)} amount={Number(e.amount)} />
            ))}
            {invoice && form.expense !== NEW_EXPENSE && (
              <Text style={[styles.noteText, styles.noteWarn]}>The invoice photo is saved only with &ldquo;Log the cost now&rdquo;.</Text>
            )}
            {form.expense === NEW_EXPENSE && (
              <>
                <View style={styles.twoCol}>
                  <View style={{ flex: 1 }}><Field label="Amount ex GST *" value={form.amount} onChange={set("amount")} num /></View>
                  <View style={{ flex: 1 }}><Field label="GST" value={form.gst_amount} onChange={set("gst_amount")} num /></View>
                </View>
                <Field label="Invoice #" value={form.invoice_number} onChange={set("invoice_number")} />
                <Text style={styles.hint}>Saved as an expense with the invoice photo, so it counts once in the yearly cost.</Text>
              </>
            )}
          </>
        )}
      </KeyboardSheet>
    </RoleGate>
  );
}

/** "Already logged: 3 Nov 2026 · Truck Centre" — the amount is drawn by MoneyText beside it. */
function linkLabel(e: ServiceExpense): string {
  return `Already logged: ${e.expense_date ? fmtDate(e.expense_date) : "no date"} · ${e.supplier_name || e.category}`;
}

function ExpenseChoice({ label, active, onPress, amount }: { label: string; active: boolean; onPress: () => void; amount?: number }) {
  return (
    <TouchableOpacity style={styles.choice} onPress={onPress} accessibilityRole="radio" accessibilityState={{ selected: active }}>
      <Ionicons name={active ? "radio-button-on" : "radio-button-off"} size={18} color={active ? colors.blue600 : colors.slate400} />
      <Text style={styles.choiceText}>{label}</Text>
      {amount !== undefined && <MoneyText amount={amount} style={styles.choiceAmount} />}
    </TouchableOpacity>
  );
}

function Field({ label, value, onChange, num, multiline, placeholder }: { label: string; value: string; onChange: (v: string) => void; num?: boolean; multiline?: boolean; placeholder?: string }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={[styles.input, multiline && styles.multiline]}
        value={value}
        onChangeText={onChange}
        keyboardType={num ? "decimal-pad" : "default"}
        multiline={multiline}
        placeholder={placeholder}
        placeholderTextColor={colors.slate400}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginTop: 16, marginBottom: 8, marginLeft: 4 },
  sectionHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  addBtn: { flexDirection: "row", alignItems: "center", gap: 4 },
  addText: { fontSize: 13, color: colors.blue600, fontWeight: "600" },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12 },
  empty: { fontSize: 13, color: colors.slate400, paddingVertical: 8, textAlign: "center" },
  retry: { fontSize: 13, color: colors.blue600, fontWeight: "600", textAlign: "center" },
  due: { flexDirection: "row", gap: 8, alignItems: "flex-start", padding: 10, borderRadius: 10, borderWidth: 1, borderColor: colors.border, marginBottom: 6 },
  dueOverdue: { backgroundColor: colors.red100, borderColor: colors.red600 },
  dueSoon: { backgroundColor: colors.orange100, borderColor: colors.orange700 },
  dueText: { fontSize: 13, fontWeight: "700", color: colors.slate900 },
  row: { flexDirection: "row", gap: 8, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.slate100 },
  rowTitle: { fontSize: 14, fontWeight: "600", color: colors.slate900 },
  meta: { fontSize: 12, color: colors.slate500, marginTop: 1 },
  expLine: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 1 },
  work: { fontSize: 13, color: colors.slate700, marginTop: 4 },
  link: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 4 },
  linkText: { fontSize: 12, color: colors.blue600, fontWeight: "600" },
  sheetTitle: { fontSize: 16, fontWeight: "800", color: colors.slate900 },
  subhead: { fontSize: 13, fontWeight: "800", color: colors.slate700, marginTop: 6, marginBottom: 8 },
  field: { marginBottom: 12 },
  fieldLabel: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase", marginBottom: 6 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: KEYBOARD_SHEET_INPUT_FONT_SIZE, backgroundColor: colors.bg, color: colors.slate900 },
  multiline: { minHeight: 56, textAlignVertical: "top" },
  twoCol: { flexDirection: "row", gap: 12 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  chipActive: { backgroundColor: colors.blue600, borderColor: colors.blue600 },
  chipText: { fontSize: 12, fontWeight: "600", color: colors.slate700 },
  chipTextActive: { color: "#fff" },
  pickBtn: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.blue100 },
  pickText: { fontSize: 13, fontWeight: "600", color: colors.blue600 },
  chosen: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 },
  chosenText: { flex: 1, fontSize: 13, fontWeight: "600", color: colors.slate700 },
  remove: { fontSize: 13, color: colors.red600, fontWeight: "600" },
  hint: { fontSize: 11, color: colors.slate400, marginTop: 6, marginBottom: 10 },
  noteRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 8 },
  noteText: { fontSize: 12, color: colors.slate500, marginBottom: 10 },
  noteOk: { color: colors.green600 },
  noteWarn: { color: colors.orange700 },
  choice: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8 },
  choiceText: { flex: 1, fontSize: 14, color: colors.slate700 },
  choiceAmount: { fontSize: 13, fontWeight: "600", color: colors.slate900 },
  actions: { flexDirection: "row", gap: 10 },
  cancel: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.bg, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  cancelText: { color: colors.slate700, fontWeight: "600", fontSize: 14 },
  saveBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.blue600, alignItems: "center" },
  saveText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  disabled: { opacity: 0.5 },
});
