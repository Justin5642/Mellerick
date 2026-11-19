import { useState } from "react";
import { View, Text, TextInput, TouchableOpacity, Alert, Modal, ScrollView, Switch } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors } from "../../lib/theme";
import { MoneyText } from "../../design/components/MoneyText";
import { RoleGate } from "../../design/guards/RoleGate";
import { KeyboardSheet } from "../KeyboardSheet";
import { openExternalUrl } from "../../lib/open-external-url";
import { formatWorkDate, invoiceDayWorks, quantityText, type DayWorksEntry, type DayWorksOfficePricing } from "../../lib/dayWorks";
import { loadSummary, setTruckLoadCost, type TruckLoad, type TruckLoadsOfficePricing, type TruckLoadsState } from "../../lib/truckLoads";
import { invoiceChoice, invoiceProblem, lastMonth, lastWeek, type InvoicePeriod } from "../../lib/dayWorksInvoice";
import { truckLoadStyles as styles } from "./truck-load-forms";

// The office's Day Works actions on the phone (19 Nov 2026) — what the web
// tab already lets office/admin do: void a signed line or load (with a
// reason), enter a load's docket cost and margin override (and see its price
// breakdown), view the docket photo, and Invoice Day Works. Every piece here
// renders only inside a RoleGate for office/admin, and every write goes to an
// office-only route (requireOfficeOrAdmin + the caller's own session, so RLS
// and the 0108/0111 triggers decide). Amounts come only from the server's
// office answer and render only through MoneyText.

const OFFICE = ["office", "admin"] as const;

/** "Void — say why" for a signed line or load. `onVoid` does the call; errors are shown here. */
export function VoidReasonSheet({ title, detail, onVoid, onClose }: { title: string; detail: string; onVoid: (reason: string | null) => Promise<void>; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  async function go() {
    if (saving) return;
    setSaving(true);
    try {
      await onVoid(reason.trim() || null);
      onClose();
    } catch (e) {
      Alert.alert("Not voided", e instanceof Error ? e.message : "Try again.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <RoleGate roles={[...OFFICE]}>
      <KeyboardSheet
        visible
        onRequestClose={onClose}
        title={title}
        footer={
          <View style={styles.actions}>
            <TouchableOpacity style={styles.cancel} onPress={onClose} accessibilityRole="button">
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.save, { backgroundColor: colors.red600 }]} onPress={() => void go()} disabled={saving} accessibilityRole="button">
              <Text style={styles.saveText}>{saving ? "Voiding…" : "Void"}</Text>
            </TouchableOpacity>
          </View>
        }
      >
        <View style={{ gap: 8 }}>
          <Text style={styles.body}>{detail}</Text>
          <Text style={styles.meta}>{"Void is final — it can't be undone. Enter a new line if it needs replacing."}</Text>
          <Text style={styles.label}>Why?</Text>
          <TextInput style={styles.input} value={reason} onChangeText={setReason} placeholder="e.g. wrong machine, entered twice" placeholderTextColor={colors.slate400} maxLength={500} />
        </View>
      </KeyboardSheet>
    </RoleGate>
  );
}

/** "Quarry product on this job" — office/admin. */
export function QuarryDefaultPicker({ value, onChange }: { value: boolean | null; onChange: (next: boolean | null) => void }) {
  const choice = value === false ? "extra" : "included";
  return (
    <RoleGate roles={[...OFFICE]}>
      <View style={{ gap: 6 }}>
        <Text style={styles.label}>Quarry product on this job</Text>
        <View style={styles.chipRow}>
          {(
            [
              ["included", "Included in the quote", true],
              ["extra", "Extra — charged", false],
            ] as const
          ).map(([key, label, next]) => (
            <TouchableOpacity
              key={key}
              style={[styles.chip, choice === key && styles.chipActive]}
              onPress={() => choice !== key && onChange(next)}
              accessibilityRole="button"
              accessibilityState={{ selected: choice === key }}
            >
              <Text style={[styles.chipText, choice === key && styles.chipTextActive]}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <Text style={styles.meta}>Spoil out is extra by default. The driver can change either on a load.</Text>
      </View>
    </RoleGate>
  );
}

/** One load's office panel: price breakdown, docket cost + margin, docket photo. */
export function LoadOfficePanel({ jobId, load: l, pricing, onSaved }: { jobId: string; load: TruckLoad; pricing: TruckLoadsOfficePricing; onSaved: (res: TruckLoadsState) => void }) {
  const price = pricing.loads[l.id];
  const [cost, setCost] = useState(price?.docketCost == null ? "" : String(price.docketCost));
  const [margin, setMargin] = useState(price?.marginOverride == null ? "" : String(price.marginOverride));
  const [saving, setSaving] = useState(false);
  if (!price) return null;
  const locked = l.status === "invoiced" || l.status === "void";
  const changed = cost !== (price.docketCost == null ? "" : String(price.docketCost)) || margin !== (price.marginOverride == null ? "" : String(price.marginOverride));

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      onSaved(await setTruckLoadCost(jobId, l.id, cost, margin));
    } catch (e) {
      Alert.alert("Docket cost not saved", e instanceof Error ? e.message : "Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <RoleGate roles={[...OFFICE]}>
      <View style={[styles.locked, { gap: 8 }]}>
        {price.lines.map((ln) => (
          <View key={ln.label} style={styles.row}>
            <Text style={styles.meta}>{ln.label}</Text>
            <MoneyText amount={ln.amount} style={styles.body} />
          </View>
        ))}
        {!!price.problem && <Text style={styles.warn}>⚠ {price.problem}</Text>}
        {locked ? (
          price.docketCost !== null && (
            <View style={styles.row}>
              <Text style={styles.meta}>Docket cost (ex GST) · margin {price.marginPct}%</Text>
              <MoneyText amount={price.docketCost} style={styles.body} />
            </View>
          )
        ) : (
          <>
            <View style={styles.actions}>
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={styles.label}>{l.direction === "spoil_out" ? "Tip fee" : "Product cost"} (docket, ex GST)</Text>
                <TextInput style={styles.input} value={cost} onChangeText={setCost} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={colors.slate400} />
              </View>
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={styles.label}>Margin % (blank = {pricing.companyMarginPct}%)</Text>
                <TextInput style={styles.input} value={margin} onChangeText={setMargin} keyboardType="decimal-pad" placeholder={String(pricing.companyMarginPct)} placeholderTextColor={colors.slate400} />
              </View>
            </View>
            {changed && (
              <TouchableOpacity style={styles.secondaryWide} onPress={() => void save()} disabled={saving} accessibilityRole="button">
                <Text style={styles.secondaryText}>{saving ? "Saving…" : "Save docket cost"}</Text>
              </TouchableOpacity>
            )}
          </>
        )}
        {!!price.docketPhotoUrl && (
          <TouchableOpacity onPress={() => void openExternalUrl(price.docketPhotoUrl!, "the docket photo")} accessibilityRole="link">
            <Text style={{ fontSize: 14, fontWeight: "600", color: colors.blue600 }}>View docket photo</Text>
          </TouchableOpacity>
        )}
      </View>
    </RoleGate>
  );
}

/** Invoice Day Works (office/admin): period, untick lines, create the draft invoice. */
export function InvoiceDayWorksSheet({
  jobId,
  today,
  entries,
  entryPricing,
  loads,
  loadPricing,
  siteLabel,
  onClose,
  onInvoiced,
}: {
  jobId: string;
  today: string;
  entries: DayWorksEntry[];
  entryPricing: DayWorksOfficePricing | undefined;
  loads: TruckLoad[];
  loadPricing: TruckLoadsOfficePricing | undefined;
  siteLabel: string | null;
  onClose: () => void;
  onInvoiced: (invoiceNumber: string) => void;
}) {
  const [period, setPeriod] = useState<InvoicePeriod>(() => lastWeek(today));
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const choice = invoiceChoice({
    entries,
    entryPricing,
    loads,
    loadPricing,
    period,
    excluded,
    entryLabel: (e) => `${e.equipment} · ${quantityText(e)}`,
    loadLabel: (l) => `${l.truck} · ${loadSummary(l, siteLabel)}`,
  });
  const problem = invoiceProblem(choice);
  const week = lastWeek(today);
  const month = lastMonth(today);
  const same = (a: InvoicePeriod | null) => !!a && a.from === period.from && a.to === period.to;

  function toggle(id: string, on: boolean) {
    setExcluded((s) => {
      const n = new Set(s);
      if (on) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function create() {
    if (busy || problem) return;
    setBusy(true);
    try {
      const res = await invoiceDayWorks(jobId, {
        entryIds: choice.picked.filter((l) => l.kind === "entry").map((l) => l.id),
        loadIds: choice.picked.filter((l) => l.kind === "load").map((l) => l.id),
        from: period.from,
        to: period.to,
      });
      onInvoiced(res.invoiceNumber == null ? "" : String(res.invoiceNumber));
    } catch (e) {
      Alert.alert("No invoice made", e instanceof Error ? e.message : "Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <RoleGate roles={[...OFFICE]}>
      <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
        <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
          <View style={[styles.row, { padding: 16 }]}>
            <Text style={styles.title}>Invoice Day Works</Text>
            <TouchableOpacity onPress={onClose} accessibilityRole="button">
              <Text style={styles.secondaryText}>Close</Text>
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
            <Text style={[styles.meta, { marginHorizontal: 16 }]}>
              Signed lines and signed extra truck loads not yet invoiced go on their own draft invoice, separate from the quoted work. {choice.waitingCount} waiting in all.
            </Text>
            <View style={[styles.chipRow, { marginHorizontal: 16, marginTop: 12 }]}>
              {(
                [
                  ["Last week", week],
                  ["Last month", month],
                  ["All waiting", choice.allWaiting],
                ] as const
              ).map(([label, p]) =>
                p ? (
                  <TouchableOpacity key={label} style={[styles.chip, same(p) && styles.chipActive]} onPress={() => setPeriod(p)} accessibilityRole="button">
                    <Text style={[styles.chipText, same(p) && styles.chipTextActive]}>{label}</Text>
                  </TouchableOpacity>
                ) : null
              )}
            </View>
            <Text style={styles.dateHeading}>
              {formatWorkDate(period.from)} – {formatWorkDate(period.to)}
            </Text>
            {choice.lines.length === 0 ? (
              <Text style={[styles.meta, { marginHorizontal: 16, marginTop: 8 }]}>No signed, un-invoiced lines in this period.</Text>
            ) : (
              choice.lines.map((line) => (
                <View key={line.id} style={[styles.card, styles.row]}>
                  <Switch value={!excluded.has(line.id)} onValueChange={(on) => toggle(line.id, on)} accessibilityLabel={`Include ${line.label}`} />
                  <Text style={[styles.body, { flex: 1 }]}>
                    {formatWorkDate(line.date)} · {line.label}
                  </Text>
                  {line.amount === null ? <Text style={styles.warn}>Not priced</Text> : <MoneyText amount={line.amount} style={styles.bodyStrong} />}
                </View>
              ))
            )}
          </ScrollView>
          <View style={{ padding: 16, gap: 8, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.card }}>
            <View style={styles.row}>
              <Text style={styles.meta}>
                {choice.picked.length} line{choice.picked.length === 1 ? "" : "s"} · ex GST
              </Text>
              <MoneyText amount={choice.total} style={styles.bodyStrong} />
            </View>
            {!!problem && choice.lines.length > 0 && <Text style={styles.warn}>{problem}</Text>}
            <TouchableOpacity style={[styles.primary, (busy || !!problem) && { opacity: 0.5 }]} onPress={() => void create()} disabled={busy || !!problem} accessibilityRole="button">
              <Text style={styles.primaryText}>{busy ? "Creating…" : "Create draft invoice"}</Text>
            </TouchableOpacity>
          </View>
        </SafeAreaView>
      </Modal>
    </RoleGate>
  );
}
