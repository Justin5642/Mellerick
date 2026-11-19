import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import {
  ApiError,
  NO_COST_CENTRE,
  applyInvoiceHours,
  hoursAppliedMessage,
  loadInvoiceHours,
  type InvoiceHoursView,
  type RateMode,
  type RateSource,
} from "../../lib/invoiceOffice";

// "Hours from the job" and "Apply hourly rate" on the phone's invoice screen —
// the web card (components/invoice/invoice-hours.tsx) over the same route
// (GET/POST /api/invoices/[id]/hours). The lines are built and priced on the
// server; the phone sends only the rates typed, and reloads from what was
// saved. Online only.

const SOURCE_LABEL: Record<RateSource, string> = {
  quote: "from the job's quote",
  charge_out: "their charge-out rate",
  company: "company rate",
};

const MODES: { value: RateMode; label: string }[] = [
  { value: "all", label: "One rate for all" },
  { value: "technician", label: "Per technician" },
  { value: "cost_centre", label: "Per cost centre" },
];

export function InvoiceHours({
  invoiceId,
  inXero,
  onUnpricedChange,
  onApplied,
}: {
  invoiceId: string;
  inXero: boolean;
  onUnpricedChange: (hours: number) => void;
  onApplied: () => void;
}) {
  const [view, setView] = useState<InvoiceHoursView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<RateMode>("all");
  const [all, setAll] = useState("");
  const [byStaff, setByStaff] = useState<Record<string, string>>({});
  const [byCostCentre, setByCostCentre] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const v = await loadInvoiceHours(invoiceId);
      setView(v);
      onUnpricedChange(v.unbilledHours);
      if (v.defaults) {
        setAll(String(v.defaults.all));
        setByStaff(Object.fromEntries(Object.entries(v.defaults.byStaff).map(([k, d]) => [k, String(d.rate)])));
        setByCostCentre(Object.fromEntries(Object.entries(v.defaults.byCostCentre).map(([k, d]) => [k, String(d.rate)])));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the job's hours");
    }
  }, [invoiceId, onUnpricedChange]);

  useEffect(() => {
    void load();
  }, [load]);

  async function apply(confirmOutside = false) {
    setApplying(true);
    try {
      const r = await applyInvoiceHours(invoiceId, { mode, all, byStaff, byCostCentre, confirmOutside });
      Alert.alert(
        "Hours applied",
        `${hoursAppliedMessage(r)}${inXero ? "\n\nThis invoice is already in Xero. Push it to Xero again so Xero has the new total." : ""}`
      );
      await load();
      onApplied();
    } catch (e) {
      if (e instanceof ApiError && e.code === "confirm_outside" && !confirmOutside) {
        Alert.alert("Add the hours?", `${e.message}\n\nAdd the hours anyway?`, [
          { text: "Cancel", style: "cancel" },
          { text: "Add anyway", onPress: () => void apply(true) },
        ]);
      } else {
        Alert.alert("Not applied", e instanceof Error ? e.message : "The hours could not be applied");
      }
    } finally {
      setApplying(false);
    }
  }

  if (error) {
    return (
      <View style={[styles.card, styles.cardError]}>
        <Text style={styles.error}>Could not load the job&apos;s hours: {error}</Text>
        <TouchableOpacity onPress={() => void load()} accessibilityRole="button">
          <Text style={styles.link}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (!view) {
    return (
      <View style={styles.card}>
        <Text style={styles.muted}>Loading the job&apos;s hours…</Text>
      </View>
    );
  }
  if (view.groups.length === 0 && view.billedElsewhereHours === 0) return null;

  const staff = [...new Map(view.groups.map((g) => [g.staffId, g.staffName])).entries()];
  const costCentres = [...new Map(view.groups.map((g) => [g.costCentreKey, g.costCentreName])).entries()];
  const hint = (s: RateSource | undefined) => (s ? `Default: ${SOURCE_LABEL[s]}` : "");
  const unpriced = view.unbilledHours > 0;

  return (
    <View style={[styles.card, unpriced && styles.cardWarn]}>
      <View style={styles.head}>
        <Text style={styles.cardTitle}>Hours from the job</Text>
        <Text style={unpriced ? styles.badgeWarn : styles.badgeOk}>
          {unpriced ? `${view.unbilledHours.toFixed(2)}h not priced yet` : `${view.billedHereHours.toFixed(2)}h on this invoice`}
        </Text>
      </View>

      {view.groups.map((g) => (
        <View key={g.key} style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowMain}>{g.staffName}</Text>
            <Text style={styles.rowSub}>{g.costCentreName ?? "No cost centre"}</Text>
          </View>
          <Text style={styles.hours}>{g.hours.toFixed(2)}h</Text>
          <Text style={g.billedHere ? styles.onInvoice : styles.notPriced}>{g.billedHere ? "On invoice" : "Not priced"}</Text>
        </View>
      ))}

      {view.billedElsewhereHours > 0 && (
        <Text style={styles.muted}>
          {view.billedElsewhereHours.toFixed(2)}h on this job are already billed (on another invoice, or as an existing Labour line) and are not shown here.
        </Text>
      )}

      {view.groups.length > 0 && !view.locked && (
        <View style={styles.applyBlock}>
          <View style={styles.chips}>
            {MODES.map((m) => (
              <TouchableOpacity
                key={m.value}
                style={[styles.chip, mode === m.value && styles.chipOn]}
                onPress={() => setMode(m.value)}
                accessibilityRole="radio"
                accessibilityState={{ checked: mode === m.value }}
              >
                <Text style={[styles.chipText, mode === m.value && styles.chipTextOn]}>{m.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          {mode === "all" && <RateInput label="All hours" value={all} onChange={setAll} hint={hint(view.defaults?.allSource)} />}
          {mode === "technician" &&
            staff.map(([id, name]) => (
              <RateInput key={id} label={name} value={byStaff[id] ?? ""} onChange={(v) => setByStaff((p) => ({ ...p, [id]: v }))} hint={hint(view.defaults?.byStaff[id]?.source)} />
            ))}
          {mode === "cost_centre" &&
            costCentres.map(([key, name]) => (
              <RateInput
                key={key}
                label={key === NO_COST_CENTRE ? "No cost centre" : (name ?? "Cost centre")}
                value={byCostCentre[key] ?? ""}
                onChange={(v) => setByCostCentre((p) => ({ ...p, [key]: v }))}
                hint={hint(view.defaults?.byCostCentre[key]?.source)}
              />
            ))}
          {inXero && <Text style={styles.warn}>This invoice is already in Xero. After applying the rate, push it to Xero again so Xero has the new total.</Text>}
          <Text style={styles.muted}>
            Adds one line per cost centre and technician (ex GST). {view.billedHereHours > 0 ? "Replaces the hours lines already on this invoice." : ""}
          </Text>
          <TouchableOpacity style={[styles.applyBtn, applying && styles.disabled]} onPress={() => void apply()} disabled={applying} accessibilityRole="button">
            {applying ? <ActivityIndicator size="small" color={colors.white} /> : <Ionicons name="timer-outline" size={16} color={colors.white} />}
            <Text style={styles.applyText}>{applying ? "Applying..." : view.billedHereHours > 0 ? "Re-apply hourly rate" : "Apply hourly rate"}</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

function RateInput({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint: string }) {
  return (
    <View style={styles.rate}>
      <Text style={styles.rateLabel}>{label}</Text>
      <View style={styles.rateRow}>
        <Text style={styles.muted}>$</Text>
        <TextInput style={styles.rateInput} value={value} onChangeText={onChange} keyboardType="decimal-pad" />
        <Text style={styles.muted}>/hr</Text>
      </View>
      {!!hint && <Text style={styles.rateHint}>{hint}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 14, gap: 8 },
  cardWarn: { borderColor: colors.orange700 },
  cardError: { borderColor: colors.red600 },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
  cardTitle: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase" },
  badgeWarn: { fontSize: 12, fontWeight: "700", color: colors.orange700 },
  badgeOk: { fontSize: 12, fontWeight: "700", color: colors.green600 },
  muted: { fontSize: 12, color: colors.slate500, lineHeight: 17 },
  warn: { fontSize: 12, color: colors.orange700, lineHeight: 17 },
  error: { fontSize: 13, color: colors.red600 },
  link: { fontSize: 13, fontWeight: "700", color: colors.blue600 },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.slate100 },
  rowMain: { fontSize: 14, fontWeight: "600", color: colors.slate900 },
  rowSub: { fontSize: 12, color: colors.slate500 },
  hours: { fontSize: 14, fontWeight: "600", color: colors.slate900 },
  onInvoice: { fontSize: 11, color: colors.green600, width: 70, textAlign: "right" },
  notPriced: { fontSize: 11, color: colors.orange700, width: 70, textAlign: "right" },
  applyBlock: { gap: 10, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.white },
  chipOn: { borderColor: colors.blue600, backgroundColor: colors.blue100 },
  chipText: { fontSize: 13, color: colors.slate700 },
  chipTextOn: { color: colors.blue600, fontWeight: "700" },
  rate: { gap: 4 },
  rateLabel: { fontSize: 13, fontWeight: "600", color: colors.slate700 },
  rateRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  rateInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 16,
    color: colors.slate900,
    backgroundColor: colors.white,
  },
  rateHint: { fontSize: 11, color: colors.slate400 },
  applyBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: colors.blue600, borderRadius: 10, paddingVertical: 12 },
  applyText: { fontSize: 14, fontWeight: "700", color: colors.white },
  disabled: { opacity: 0.6 },
});
