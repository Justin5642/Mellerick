import { useEffect, useRef } from "react";
import { StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "../../lib/theme";
import { MoneyText } from "../../design/components/MoneyText";
import { nextClaimDefaults, progressBreakdown, type ClaimDraft } from "../../lib/progressClaim";
import { getPreviousClaim } from "../../lib/data/reads/invoiceExtras";

// "Progress claim" on the phone's New / Edit Invoice — the web's
// components/invoice/progress-claim-fields.tsx. Ticking it fills the claim
// number, contract value and previously-claimed amount from the job's latest
// claim (on the picked builder PO when the job has several), else the job's
// PO value; every figure can be changed. The previous claim is read from the
// server (it may be outside the phone's window); offline the fields are left
// for the office to type. Rules: lib/progressClaim.ts (mirror of the web's).

export function ProgressClaimFields({
  value,
  onChange,
  jobId,
  currentInvoiceId,
  subtotal,
  jobPoTotal,
  builderPo,
}: {
  value: ClaimDraft;
  onChange: (d: ClaimDraft) => void;
  jobId: string | null;
  currentInvoiceId?: string;
  /** This claim, ex GST. */
  subtotal: number;
  /** The job's POs' total value — the contract value with no earlier claim. */
  jobPoTotal: number | null;
  builderPo: { poNumber: string; value: number } | null;
}) {
  const prefillKey = `${jobId}:${builderPo?.poNumber ?? ""}`;
  const prefilledFor = useRef<string | null>(value.on && value.contract ? prefillKey : null);

  useEffect(() => {
    if (!value.on || !jobId || prefilledFor.current === prefillKey) return;
    prefilledFor.current = prefillKey;
    let cancelled = false;
    void (async () => {
      try {
        const latest = await getPreviousClaim(jobId, { excludeInvoiceId: currentInvoiceId, poNumber: builderPo?.poNumber ?? null });
        if (cancelled) return;
        const simproValue = builderPo ? builderPo.value || null : jobPoTotal || null;
        const d = nextClaimDefaults(latest, simproValue);
        onChange({
          on: true,
          number: String(d.claimNumber),
          contract: d.contractValue != null ? String(d.contractValue) : "",
          previous: String(d.previous),
        });
      } catch {
        // Offline or refused: leave the fields for the office to type.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.on, jobId, builderPo?.poNumber]);

  const contract = parseFloat(value.contract);
  const preview =
    value.on && contract > 0
      ? progressBreakdown({
          claimNumber: parseInt(value.number, 10) || 1,
          contractValue: contract,
          previous: parseFloat(value.previous) || 0,
          thisClaim: subtotal,
        })
      : null;

  return (
    <View style={styles.card}>
      <TouchableOpacity
        style={styles.toggle}
        onPress={() => onChange({ ...value, on: !value.on })}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: value.on }}
      >
        <Ionicons name={value.on ? "checkbox" : "square-outline"} size={22} color={colors.blue600} />
        <Text style={styles.toggleText}>Progress claim</Text>
      </TouchableOpacity>
      {value.on && (
        <>
          {!jobId && <Text style={styles.warn}>Link a job to fill these in from its earlier claims.</Text>}
          <Field label="Claim no." value={value.number} onChange={(v) => onChange({ ...value, number: v })} keyboard="number-pad" />
          <Field label="Contract value (ex GST)" value={value.contract} onChange={(v) => onChange({ ...value, contract: v })} placeholder="e.g. 9200" />
          <Field label="Previously claimed (ex GST)" value={value.previous} onChange={(v) => onChange({ ...value, previous: v })} placeholder="0" />
          <Text style={styles.hint}>
            Filled from this job&rsquo;s last claim, or the job&rsquo;s PO value. On the first claim raised here, add anything already claimed in
            Simpro to &ldquo;Previously claimed&rdquo;.
          </Text>
          {preview && (
            <View style={styles.preview}>
              <PreviewRow label="Previously claimed" amount={preview.previous} pct={preview.pctPrevious} />
              <PreviewRow label="This claim" amount={preview.thisClaim} pct={preview.pctThis} />
              <PreviewRow label="Claimed to date" amount={preview.toDate} pct={preview.pctToDate} />
              <PreviewRow label="Balance to claim" amount={preview.balance} negative={preview.balance < 0} />
              {preview.balance < 0 && <Text style={styles.over}>This claim takes the job over its contract value.</Text>}
            </View>
          )}
        </>
      )}
    </View>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  keyboard = "decimal-pad",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  keyboard?: "number-pad" | "decimal-pad";
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput style={styles.input} value={value} onChangeText={onChange} keyboardType={keyboard} placeholder={placeholder} placeholderTextColor={colors.slate400} />
    </View>
  );
}

function PreviewRow({ label, amount, pct, negative }: { label: string; amount: number; pct?: number; negative?: boolean }) {
  return (
    <View style={styles.previewRow}>
      <Text style={styles.previewLabel}>{label}</Text>
      <Text style={[styles.previewValue, negative && styles.overText]}>
        <MoneyText amount={amount} style={[styles.previewValue, negative && styles.overText]} />
        {pct != null ? ` · ${pct}%` : ""}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 12, backgroundColor: colors.card, gap: 8, marginTop: 18 },
  toggle: { flexDirection: "row", alignItems: "center", gap: 10 },
  toggleText: { fontSize: 15, fontWeight: "700", color: colors.slate900 },
  warn: { fontSize: 12, color: colors.orange700 },
  hint: { fontSize: 11, color: colors.slate400, lineHeight: 15 },
  field: { gap: 4 },
  label: { fontSize: 12, fontWeight: "700", color: colors.slate500, textTransform: "uppercase" },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 14, backgroundColor: colors.white, color: colors.slate900 },
  preview: { backgroundColor: colors.slate100, borderRadius: 8, padding: 10, gap: 4 },
  previewRow: { flexDirection: "row", justifyContent: "space-between" },
  previewLabel: { fontSize: 12, color: colors.slate500 },
  previewValue: { fontSize: 12, fontWeight: "700", color: colors.slate900 },
  overText: { color: colors.red600 },
  over: { fontSize: 12, color: colors.red600 },
});
