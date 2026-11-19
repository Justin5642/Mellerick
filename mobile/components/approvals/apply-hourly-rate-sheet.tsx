import { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, TextInput, Alert, ActivityIndicator } from "react-native";
import { KeyboardSheet, KEYBOARD_SHEET_INPUT_FONT_SIZE } from "../KeyboardSheet";
import { colors } from "../../lib/theme";
import { RoleGate } from "../../design/guards/RoleGate";
import { MoneyText } from "../../design/components/MoneyText";
import { OfficeApiError } from "../../lib/officeApi";
import {
  RATE_MODES,
  SOURCE_LABEL,
  applyHourlyRate,
  initialRateForm,
  loadInvoiceHours,
  rateFormProblem,
  rateTargets,
  type InvoiceHoursView,
  type RateForm,
  type RateSource,
} from "../../lib/approvalHours";

// "Apply hourly rate" on the phone (web components/invoice/invoice-hours.tsx):
// the job's clocked hours priced onto its invoice, one line per cost centre ×
// technician. The server builds the lines from the database
// (POST /api/invoices/[id]/hours, office/admin) — the phone sends only the
// rates, and says "done" only when the server has saved them.
export function ApplyHourlyRateSheet({
  invoiceId,
  visible,
  onClose,
}: {
  invoiceId: string | null;
  visible: boolean;
  onClose: () => void;
}) {
  const [view, setView] = useState<InvoiceHoursView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<RateForm>({ mode: "all", all: "", byStaff: {}, byCostCentre: {} });
  const [applying, setApplying] = useState(false);
  const [done, setDone] = useState<{ hours: number; lines: number; total: number } | null>(null);

  const load = useCallback(async () => {
    if (!invoiceId) return;
    setLoadError(null);
    try {
      const v = await loadInvoiceHours(invoiceId);
      setView(v);
      setForm(initialRateForm(v));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load the job's hours.");
    }
  }, [invoiceId]);

  useEffect(() => {
    if (!visible) return;
    setView(null);
    setDone(null);
    void load();
  }, [visible, load]);

  async function apply(confirmOutside = false) {
    if (!invoiceId || !view || applying) return;
    const problem = rateFormProblem(form, view.groups);
    if (problem) {
      Alert.alert("Rate needed", problem);
      return;
    }
    setApplying(true);
    try {
      const r = await applyHourlyRate(invoiceId, form, confirmOutside);
      setDone({ hours: r.hours, lines: r.lines, total: r.total });
      // Show what was saved (rows now "On invoice").
      await load();
    } catch (e) {
      if (e instanceof OfficeApiError && e.code === "confirm_outside" && !confirmOutside) {
        setApplying(false);
        Alert.alert("Change a sent invoice?", e.message, [
          { text: "Cancel", style: "cancel" },
          { text: "Add the hours anyway", onPress: () => void apply(true) },
        ]);
        return;
      }
      Alert.alert("Couldn't apply the rate", e instanceof Error ? e.message : "Please try again.");
    } finally {
      setApplying(false);
    }
  }

  const targets = view ? rateTargets(view.groups) : { staff: [], costCentres: [] };
  const hint = (s: RateSource | undefined) => (s ? `Default: ${SOURCE_LABEL[s]}` : "");
  const canApply = !!view && view.groups.length > 0 && !view.locked;

  return (
    <KeyboardSheet
      visible={visible}
      onRequestClose={onClose}
      title="Apply hourly rate"
      testID="apply-hourly-rate-sheet"
      footer={
        <View style={styles.footer}>
          <TouchableOpacity style={styles.cancel} onPress={onClose} disabled={applying}>
            <Text style={styles.cancelText}>{done ? "Done" : "Close"}</Text>
          </TouchableOpacity>
          {canApply && (
            <TouchableOpacity style={[styles.apply, applying && styles.disabled]} onPress={() => void apply()} disabled={applying}>
              {applying ? <ActivityIndicator color="#fff" size="small" /> : null}
              <Text style={styles.applyText}>{view && view.billedHereHours > 0 ? "Re-apply rate" : "Apply rate"}</Text>
            </TouchableOpacity>
          )}
        </View>
      }
    >
      {/* Office/admin only — the sheet prices an invoice. */}
      <RoleGate roles={["admin", "office"]}>
        {loadError ? (
          <TouchableOpacity onPress={() => void load()}>
            <Text style={styles.error}>Couldn&apos;t load the job&apos;s hours: {loadError} Tap to retry.</Text>
          </TouchableOpacity>
        ) : !view ? (
          <ActivityIndicator color={colors.blue600} style={{ marginVertical: 24 }} />
        ) : (
          <View style={styles.body}>
            {done && (
              <View style={styles.doneBox}>
                <Text style={styles.doneText}>
                  {done.hours.toFixed(2)}h billed on {done.lines} line{done.lines === 1 ? "" : "s"} — invoice total now{" "}
                </Text>
                <MoneyText amount={done.total} style={styles.doneMoney} />
                <Text style={styles.doneText}> inc GST.</Text>
                {view.outside === "xero" && <Text style={styles.warn}>Push it to Xero again so Xero has the new total.</Text>}
              </View>
            )}

            {view.groups.length === 0 ? (
              <Text style={styles.muted}>No clocked hours left to price on this job.</Text>
            ) : (
              <View style={styles.table}>
                {view.groups.map((g) => (
                  <View key={g.key} style={styles.tableRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.cell} numberOfLines={1}>{g.costCentreName ?? "No cost centre"}</Text>
                      <Text style={styles.cellSub} numberOfLines={1}>{g.staffName}</Text>
                    </View>
                    <Text style={styles.hours}>{g.hours.toFixed(2)}h</Text>
                    <Text style={[styles.status, g.billedHere ? styles.statusOn : styles.statusOff]}>{g.billedHere ? "On invoice" : "Not priced"}</Text>
                  </View>
                ))}
              </View>
            )}
            {view.billedElsewhereHours > 0 && (
              <Text style={styles.muted}>
                {view.billedElsewhereHours.toFixed(2)}h on this job are already billed elsewhere (another invoice or an existing Labour line).
              </Text>
            )}

            {view.locked ? (
              <Text style={styles.warn}>This invoice is paid, part-paid or cancelled, so its lines can&apos;t change. Bill these hours on a new invoice.</Text>
            ) : view.groups.length > 0 ? (
              <>
                <View style={styles.modes}>
                  {RATE_MODES.map((m) => (
                    <TouchableOpacity
                      key={m.value}
                      style={[styles.mode, form.mode === m.value && styles.modeActive]}
                      onPress={() => setForm((f) => ({ ...f, mode: m.value }))}
                    >
                      <Text style={[styles.modeText, form.mode === m.value && styles.modeTextActive]}>{m.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
                {form.mode === "all" && (
                  <RateInput label="All hours" value={form.all} onChange={(v) => setForm((f) => ({ ...f, all: v }))} hint={hint(view.defaults?.allSource)} />
                )}
                {form.mode === "technician" &&
                  targets.staff.map((s) => (
                    <RateInput
                      key={s.id}
                      label={s.name}
                      value={form.byStaff[s.id] ?? ""}
                      onChange={(v) => setForm((f) => ({ ...f, byStaff: { ...f.byStaff, [s.id]: v } }))}
                      hint={hint(view.defaults?.byStaff[s.id]?.source)}
                    />
                  ))}
                {form.mode === "cost_centre" &&
                  targets.costCentres.map((c) => (
                    <RateInput
                      key={c.key}
                      label={c.name}
                      value={form.byCostCentre[c.key] ?? ""}
                      onChange={(v) => setForm((f) => ({ ...f, byCostCentre: { ...f.byCostCentre, [c.key]: v } }))}
                      hint={hint(view.defaults?.byCostCentre[c.key]?.source)}
                    />
                  ))}
                <Text style={styles.muted}>
                  Adds one line per cost centre and technician (ex GST).{view.billedHereHours > 0 ? " Replaces the hours lines already on this invoice." : ""}
                </Text>
                {view.outside === "xero" && <Text style={styles.warn}>Already in Xero — push it again after applying so Xero has the new total.</Text>}
              </>
            ) : null}
          </View>
        )}
      </RoleGate>
    </KeyboardSheet>
  );
}

function RateInput({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint: string }) {
  return (
    <View style={styles.rateField}>
      <Text style={styles.rateLabel}>{label}</Text>
      <View style={styles.rateRow}>
        <Text style={styles.ratePrefix}>$</Text>
        <TextInput style={styles.rateInput} value={value} onChangeText={onChange} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={colors.slate400} />
        <Text style={styles.ratePrefix}>/hr</Text>
      </View>
      {hint ? <Text style={styles.rateHint}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: 12 },
  footer: { flexDirection: "row", gap: 10 },
  cancel: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.bg, alignItems: "center", borderWidth: 1, borderColor: colors.border },
  cancelText: { color: colors.slate700, fontWeight: "600", fontSize: 14 },
  apply: { flex: 1, flexDirection: "row", gap: 6, paddingVertical: 12, borderRadius: 10, backgroundColor: colors.blue600, alignItems: "center", justifyContent: "center" },
  applyText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  disabled: { opacity: 0.6 },
  error: { fontSize: 13, color: colors.red600 },
  muted: { fontSize: 12, color: colors.slate500 },
  warn: { fontSize: 12, color: colors.orange700, fontWeight: "600" },
  table: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, overflow: "hidden" },
  tableRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.border },
  cell: { fontSize: 13, fontWeight: "600", color: colors.slate900 },
  cellSub: { fontSize: 12, color: colors.slate500 },
  hours: { fontSize: 13, fontWeight: "700", color: colors.slate900 },
  status: { fontSize: 11, fontWeight: "700", minWidth: 70, textAlign: "right" },
  statusOn: { color: colors.green600 },
  statusOff: { color: colors.orange700 },
  modes: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  mode: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  modeActive: { backgroundColor: colors.blue600, borderColor: colors.blue600 },
  modeText: { fontSize: 13, fontWeight: "600", color: colors.slate700 },
  modeTextActive: { color: "#fff" },
  rateField: { gap: 4 },
  rateLabel: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase" },
  rateRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  ratePrefix: { fontSize: 14, color: colors.slate500 },
  rateInput: { flex: 1, borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: KEYBOARD_SHEET_INPUT_FONT_SIZE, backgroundColor: colors.bg, color: colors.slate900 },
  rateHint: { fontSize: 11, color: colors.slate400 },
  doneBox: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", backgroundColor: colors.green100, borderRadius: 10, padding: 10 },
  doneText: { fontSize: 13, color: colors.slate700 },
  doneMoney: { fontSize: 13, fontWeight: "700", color: colors.slate900 },
});
